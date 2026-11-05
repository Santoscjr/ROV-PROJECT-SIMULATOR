import { Vector3 } from 'three';
import { RovPhysics, type ImpactEvent, type PhysicsEnvironment } from '../physics/rovPhysics';
import { SegmentTether } from '../physics/segmentTether';
import { TmsWinch } from './tms';
import { RovController, PILOT_MODES, type PilotMode } from '../control/rovController';
import type { MissionDefinition, MissionInput, OperationMission } from '../mission/types';
import { missionById } from '../mission/catalog';
import { currentAt } from './ocean';
import { DEFAULT_CONDITIONS, resolveConditions, type ConditionChoice, type EnvironmentConditions } from './conditions';
import { terrainHeight } from './terrain';
import { COLLIDERS, LAUNCH_HANG_HEIGHT, LAUNCH_POINT, LAUNCH_RELEASE_DEPTH, TMS } from './site';
import { zeroAxes, type AxisCommand } from '../input/types';

export type CraneState = 'hanging' | 'lowering' | 'released' | 'latching' | 'lifting' | 'onDeck';

export const FIXED_DT = 1 / 120;
const LOWER_SPEED = 0.8;
const LIFT_SPEED = 0.9;

export interface SimEvents {
  impacts: ImpactEvent[];
  /** +1 entered water, −1 left water (vehicle), for audio/FX. */
  splash: number;
  released: boolean;
}

/**
 * Simulation core, independent of rendering: physics, pilot assistance,
 * launch & recovery crane, mission logic and operational state.
 */
export class Simulation {
  readonly rov = new RovPhysics();
  readonly controller = new RovController(this.rov);
  mission!: OperationMission;
  missionDef: MissionDefinition = missionById('inspection');
  readonly env: PhysicsEnvironment;
  /** Umbilical from the vessel (launch point) to the vehicle. */
  readonly tether: SegmentTether;
  /** TMS winch managing the tether length. */
  readonly tms = new TmsWinch();
  /** Tether exit point at the TMS (world). */
  readonly tmsExit = new Vector3(TMS.exit.x, TMS.exit.y, TMS.exit.z);
  /** Pilot's choice of conditions (Settings). */
  conditionChoice: ConditionChoice = { ...DEFAULT_CONDITIONS };
  /** Effective conditions = pilot's choice + mission overrides. */
  conditions: EnvironmentConditions = resolveConditions(DEFAULT_CONDITIONS);
  crane: CraneState = 'hanging';
  /** Lamp level 0..1 and on/off state. */
  lightLevel = 0.8;
  lightsOn = false;
  readonly command: AxisCommand = zeroAxes();
  /** Accumulated time not yet simulated (fixed-step loop). */
  private accumulator = 0;
  private wasSubmerged = false;
  private events: SimEvents = { impacts: [], splash: 0, released: false };
  private readonly craneHook = new Vector3();
  altitude: number | null = null;
  readonly launchPoint = new Vector3(LAUNCH_POINT.x, 0, LAUNCH_POINT.z);
  private readonly tmp = new Vector3();

  constructor(defaultMode: PilotMode = 'stabilize', missionId = 'inspection') {
    this.missionDef = missionById(missionId);
    this.env = {
      current: (p, out) => {
        const depth = -p.y;
        const alt = p.y - terrainHeight(p.x, p.z);
        const c = currentAt(depth, alt, this.rov.time, this.conditions.current);
        return out.set(c.x, c.y, c.z);
      },
      terrainHeight,
      colliders: COLLIDERS,
    };
    this.tether = new SegmentTether(this.env.current, {}, terrainHeight, COLLIDERS);
    this.env.tether = this.tether;
    this.reset(defaultMode);
  }

  /** Update the pilot's condition choice (mission overrides still apply). */
  setConditionChoice(choice: ConditionChoice): void {
    this.conditionChoice = { ...choice };
    this.conditions = resolveConditions(this.conditionChoice, this.missionDef.forcedConditions);
  }

  /** Start (or restart) an operation. */
  reset(mode: PilotMode, def: MissionDefinition = this.missionDef): void {
    this.missionDef = def;
    this.conditions = resolveConditions(this.conditionChoice, def.forcedConditions);
    this.controller.mode = mode;
    this.mission = def.create();
    this.accumulator = 0;
    Object.assign(this.command, zeroAxes());
    if (def.start === 'crane') {
      // Body +X forward; yaw π/2 about +Y turns +X to −Z (north).
      this.rov.reset(new Vector3(LAUNCH_POINT.x, LAUNCH_HANG_HEIGHT, LAUNCH_POINT.z), Math.PI / 2);
      this.rov.kinematic = true;
      this.rov.kinematicYaw = Math.PI / 2;
      this.rov.kinematicTarget.copy(this.rov.position);
      this.crane = 'hanging';
      this.lightsOn = false;
      this.wasSubmerged = false;
    } else {
      const p = def.start.position;
      this.rov.reset(new Vector3(p.x, p.y, p.z), ((90 - def.start.heading) * Math.PI) / 180);
      this.rov.kinematic = false;
      this.crane = 'released';
      this.lightsOn = def.start.lights;
      this.wasSubmerged = true;
    }
    this.lightLevel = 0.8;
    const chord = this.tmsExit.distanceTo(this.rov.position);
    const t = def.tms ?? { mode: 'auto' as const };
    this.tms.reset(t.payout ?? chord * 1.12 + 6, t.mode);
    this.tether.payout = this.tms.payout;
    this.tether.reset(this.tmsExit, this.rov.position);
    this.tether.enabled = this.crane === 'released';
    this.controller.reset();
  }

  setMode(mode: PilotMode): boolean {
    this.controller.setMode(mode);
    return true;
  }

  cycleMode(): PilotMode {
    const i = PILOT_MODES.indexOf(this.controller.mode);
    const next = PILOT_MODES[(i + 1) % PILOT_MODES.length];
    this.setMode(next);
    return next;
  }

  get effectiveLight(): number {
    return this.lightsOn ? this.lightLevel : 0;
  }

  /** Advance by real elapsed time using fixed physics steps. Returns events. */
  advance(elapsed: number): SimEvents {
    this.events = { impacts: [], splash: 0, released: false };
    this.accumulator += Math.min(elapsed, 0.25); // avoid spiral of death after tab switch
    while (this.accumulator >= FIXED_DT) {
      this.fixedStep(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    return this.events;
  }

  private fixedStep(dt: number): void {
    const rov = this.rov;
    if (this.mission.consumeLaunchRequest()) this.crane = 'lowering';
    if (this.mission.consumeRecoveryRequest()) this.crane = 'latching';

    // Crane / LARS.
    switch (this.crane) {
      case 'hanging':
        rov.kinematic = true;
        this.craneHook.set(this.launchPoint.x, LAUNCH_HANG_HEIGHT, this.launchPoint.z);
        break;
      case 'lowering':
        rov.kinematic = true;
        this.craneHook.set(this.launchPoint.x, Math.max(-LAUNCH_RELEASE_DEPTH, this.craneHook.y - LOWER_SPEED * dt), this.launchPoint.z);
        if (this.craneHook.y <= -LAUNCH_RELEASE_DEPTH + 1e-3 && rov.position.y < -LAUNCH_RELEASE_DEPTH + 0.15) {
          this.crane = 'released';
          rov.kinematic = false;
          rov.velocity.set(0, 0, 0);
          this.controller.reset();
          this.events.released = true;
        }
        break;
      case 'released':
        break;
      case 'latching': {
        rov.kinematic = true;
        rov.kinematicYaw = Math.PI / 2;
        const target = this.tmp.set(this.launchPoint.x, rov.position.y, this.launchPoint.z);
        this.craneHook.copy(rov.position).lerp(target, 0.02);
        if (rov.position.distanceTo(target) < 0.3) this.crane = 'lifting';
        break;
      }
      case 'lifting':
        rov.kinematic = true;
        this.craneHook.set(this.launchPoint.x, Math.min(LAUNCH_HANG_HEIGHT, this.craneHook.y + LIFT_SPEED * dt), this.launchPoint.z);
        if (rov.position.y > LAUNCH_HANG_HEIGHT - 0.1) this.crane = 'onDeck';
        break;
      case 'onDeck':
        rov.kinematic = true;
        break;
    }
    rov.kinematicTarget.copy(this.craneHook);

    this.tether.enabled = this.crane === 'released';
    if (this.tether.enabled) this.tms.update(dt, this.tether.chordLength, this.tether.tension);
    else this.tms.payout = Math.max(this.tms.payout, this.tmsExit.distanceTo(rov.position) * 1.12 + 6);
    this.tether.payout = this.tms.payout;
    this.tether.setVehicle(rov.position, rov.orientation);

    // Pilot → controller → thrusters (thrusters also run on deck for the pre-dive check).
    this.controller.update(this.command, dt);
    rov.step(dt, this.env);

    for (const imp of rov.takeImpacts()) {
      this.events.impacts.push(imp);
      this.mission.recordCollision({ time: this.mission.time, speed: imp.speed, kind: imp.kind });
    }
    const submerged = rov.position.y < 0;
    if (submerged !== this.wasSubmerged) this.events.splash = submerged ? 1 : -1;
    this.wasSubmerged = submerged;
  }

  /** Update the mission with the latest state (called once per frame). */
  updateMission(dt: number, view: Pick<MissionInput, 'cameraPosition' | 'cameraDirection' | 'cameraMode'>): void {
    this.altitude = this.rov.altitude(this.env);
    const vw = this.rov.worldVelocity(this.tmp);
    const c = this.command;
    this.mission.update({
      dt,
      depth: this.rov.depth,
      altitude: this.altitude,
      position: { x: this.rov.position.x, y: this.rov.position.y, z: this.rov.position.z },
      velocity: { x: vw.x, y: vw.y, z: vw.z },
      angularRate: (this.rov.angularVelocity.length() * 180) / Math.PI,
      cameraPosition: view.cameraPosition,
      cameraDirection: view.cameraDirection,
      cameraMode: view.cameraMode,
      lightLevel: this.effectiveLight,
      heading: this.rov.heading,
      pilotMode: this.controller.mode,
      commanding: Math.abs(c.surge) + Math.abs(c.sway) + Math.abs(c.heave) + Math.abs(c.yaw) > 0.05,
      craneReleased: this.crane === 'released',
      craneOnDeck: this.crane === 'onDeck',
    });
  }

  /** Hook position for drawing the crane wire (null when released). */
  wireEnd(): Vector3 | null {
    return this.crane === 'released' ? null : this.craneHook;
  }

  /** Umbilical length paid out (m), straight-line approximation with slack. */
  tetherOut(): number {
    return this.tms.payout;
  }
}
