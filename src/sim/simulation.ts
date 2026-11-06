import { Quaternion, Vector3 } from 'three';
import { RovPhysics, type ImpactEvent, type PhysicsEnvironment } from '../physics/rovPhysics';
import { SegmentTether } from '../physics/segmentTether';
import { TmsWinch } from './tms';
import { RovController, PILOT_MODES, type PilotMode } from '../control/rovController';
import type { MissionDefinition, MissionInput, OperationMission } from '../mission/types';
import { missionById } from '../mission/catalog';
import { currentAt } from './ocean';
import { DEFAULT_CONDITIONS, resolveConditions, type ConditionChoice, type EnvironmentConditions } from './conditions';
import { terrainHeight } from './terrain';
import { activeEnvironment } from './environment';
import { COLLIDERS, LAUNCH_HANG_HEIGHT, LAUNCH_POINT } from './site';
import { TOPHAT, TopHat, type LarsState } from './topHat';
import { zeroAxes, type AxisCommand } from '../input/types';

/** Legacy view of the launch/recovery state (HUD, tests). */
/** Minimum altitude of the latched ROV skids above the seabed when the Top-Hat stops (m). */
export const TMS_MIN_ALTITUDE = 6;
/** Shallowest operating depth of the Top-Hat (m). */
export const TMS_MIN_DEPTH = 15;
/** Distance from the Top-Hat centre down to the latched ROV's skids (m). */
const TMS_STACK = TOPHAT.dockDrop + 1.0;

/**
 * Top-Hat operating depth for a requested depth: never deeper than the seabed
 * under the launch point minus the latched ROV and a safe altitude.
 */
export function safeTmsDepth(requested: number, seabedDepth = -terrainHeight(LAUNCH_POINT.x, LAUNCH_POINT.z)): number {
  const max = Math.max(TMS_MIN_DEPTH, seabedDepth - TMS_STACK - TMS_MIN_ALTITUDE);
  return Math.min(max, Math.max(TMS_MIN_DEPTH, requested));
}

export type CraneState = 'hanging' | 'lowering' | 'docked' | 'released' | 'lifting' | 'onDeck';
const CRANE_OF: Record<LarsState, CraneState> = { deck: 'hanging', lowering: 'lowering', atDepth: 'docked', released: 'released', raising: 'lifting', onDeck: 'onDeck' };

export const FIXED_DT = 1 / 120;

export interface SimEvents {
  impacts: ImpactEvent[];
  /** +1 entered water, −1 left water (vehicle), for audio/FX. */
  splash: number;
  released: boolean;
  docked: boolean;
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
  /** Top-Hat TMS launch & recovery system. */
  readonly lars = new TopHat(LAUNCH_POINT.x, LAUNCH_POINT.z, LAUNCH_HANG_HEIGHT + TOPHAT.dockDrop);
  /** Default operating depth of the TMS (m), from Settings. */
  tmsDepth = 80;
  private readonly _exit = new Vector3();
  /** Pilot's choice of conditions (Settings). */
  conditionChoice: ConditionChoice = { ...DEFAULT_CONDITIONS };
  /** Effective conditions = pilot's choice + mission overrides. */
  conditions: EnvironmentConditions = resolveConditions(DEFAULT_CONDITIONS);
  /** Launch/recovery state (legacy names). Setting 'released' frees the ROV (tests/tools). */
  get crane(): CraneState {
    return CRANE_OF[this.lars.state];
  }
  set crane(v: CraneState) {
    if (v === 'released') {
      this.lars.state = 'released';
      this.rov.kinematic = false;
      this.tether.enabled = true;
    }
  }
  /** Tether exit point at the TMS (world). */
  get tmsExit(): Vector3 {
    return this.lars.exitWorld(this._exit);
  }
  /** Lamp level 0..1 and on/off state. */
  lightLevel = 0.8;
  lightsOn = false;
  readonly command: AxisCommand = zeroAxes();
  /** Accumulated time not yet simulated (fixed-step loop). */
  private accumulator = 0;
  private wasSubmerged = false;
  private events: SimEvents = { impacts: [], splash: 0, released: false, docked: false };
  private readonly tmpC = new Vector3();
  private readonly tmpPull = new Vector3();
  /** Latch fully engaged: the ROV moves rigidly with the TMS (after the capture pull-in). */
  private latchRigid = true;
  altitude: number | null = null;
  readonly launchPoint = new Vector3(LAUNCH_POINT.x, 0, LAUNCH_POINT.z);
  private readonly tmp = new Vector3();
  private readonly tmpQ = new Quaternion();

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
      colliders: [...COLLIDERS, this.lars.collider],
      // Boulders and rock berm of the active environment (seed), via its spatial grid.
      queryColliders: (minX, minZ, maxX, maxZ, out) => activeEnvironment().queryColliders(minX, minZ, maxX, maxZ, out),
    };
    // Tether: structures + rock berm. The boulders need SegmentTether's spatial
    // query (pending patch: 5th argument `activeEnvironment().grid`); as a flat
    // list they doubled the cost of every tether step.
    // Static structures as a list + every physical rock (boulders, berm) through the spatial grid.
    this.tether = new SegmentTether(this.env.current, {}, terrainHeight, COLLIDERS, activeEnvironment().grid);
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
    // The ROV always starts latched under the Top-Hat: on deck (full launch) or at depth.
    const heading = def.start === 'crane' ? 0 : def.start.heading;
    this.lars.yaw = ((90 - heading) * Math.PI) / 180;
    this.lars.reset(def.start === 'crane' ? 'deck' : 'atDepth', safeTmsDepth(def.tms?.depth ?? this.tmsDepth));
    this.rov.reset(this.lars.dockPosition(), this.lars.yaw);
    this.rov.kinematic = true;
    this.rov.kinematicYaw = this.lars.yaw;
    this.rov.kinematicTarget.copy(this.rov.position);
    this.latchRigid = true;
    this.lightsOn = def.start === 'crane' ? false : def.start.lights;
    this.wasSubmerged = this.rov.position.y < 0;
    this.lightLevel = 0.8;
    this.tms.reset(this.tms.config.minLength, def.tms?.mode ?? 'auto');
    this.tether.payout = this.tms.payout;
    this.tether.reset(this.tmsExit, this.attachWorld());
    this.tether.enabled = false;
    this.controller.reset();
    if (def.start !== 'crane' && def.start.released) this.startReleasedAt(def.start.position, this.lars.yaw);
  }

  /**
   * Subsea start already released: the vehicle is free at `pos` and the winch has
   * paid out the tether a pilot would have used to get there (chord + working slack).
   */
  private startReleasedAt(pos: { x: number; y: number; z: number }, yaw: number): void {
    if (!this.lars.release()) return;
    this.rov.kinematic = false;
    this.rov.reset(new Vector3(pos.x, pos.y, pos.z), yaw);
    this.latchRigid = false;
    const chord = this.tmsExit.distanceTo(this.rov.position);
    const c = this.tms.config;
    this.tms.reset(Math.min(c.maxLength, chord * (1 + c.autoSlackFraction) + c.autoSlack), this.tms.mode);
    this.tether.payout = this.tms.payout;
    this.tether.reset(this.tmsExit, this.attachWorld());
    this.tether.enabled = true;
    this.controller.reset();
  }

  /**
   * Free mode: recover the latched assembly to the deck, or lower it again from
   * the deck. Returns the action taken (null if the ROV must dock first).
   */
  toggleAssembly(): 'raising' | 'lowering' | null {
    const lars = this.lars;
    if (lars.state === 'atDepth') return lars.startRaise() ? 'raising' : null;
    if (lars.state === 'onDeck' || lars.state === 'deck') {
      lars.depth = safeTmsDepth(this.tmsDepth);
      lars.state = 'deck';
      return lars.startLowering() ? 'lowering' : null;
    }
    return null;
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

  /** Tether termination on the ROV (world). */
  attachWorld(out = new Vector3()): Vector3 {
    return out.copy(this.rov.tetherAttach).applyQuaternion(this.rov.orientation).add(this.rov.position);
  }

  /** Release the ROV from the Top-Hat (only when latched at depth). */
  releaseRov(): boolean {
    if (!this.lars.release()) return false;
    this.rov.kinematic = false;
    this.rov.velocity.set(0, 0, 0);
    this.rov.angularVelocity.set(0, 0, 0);
    this.tms.reset(Math.max(this.tms.config.minLength, 4), this.tms.mode);
    this.tether.payout = this.tms.payout;
    // Lay the initial bight aft of (and below) the TMS exit, clear of the ROV body.
    const yaw = this.lars.yaw;
    this.tmp.set(-Math.cos(yaw), -0.5, Math.sin(yaw));
    this.tether.reset(this.tmsExit, this.attachWorld(), this.tmp);
    this.tether.enabled = true;
    this.controller.reset();
    this.events.released = true;
    return true;
  }

  /** Start the ascent of the latched assembly (recovery to deck). */
  raiseAssembly(): boolean {
    return this.lars.startRaise();
  }

  get effectiveLight(): number {
    return this.lightsOn ? this.lightLevel : 0;
  }

  /** Advance by real elapsed time using fixed physics steps. Returns events. */
  advance(elapsed: number): SimEvents {
    this.events = { impacts: [], splash: 0, released: false, docked: false };
    this.accumulator += Math.min(elapsed, 0.25); // avoid spiral of death after tab switch
    while (this.accumulator >= FIXED_DT) {
      this.fixedStep(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    return this.events;
  }

  private fixedStep(dt: number): void {
    const rov = this.rov;
    const lars = this.lars;
    if (this.mission.consumeLaunchRequest()) lars.startLowering();
    if (this.mission.consumeRecoveryRequest()) lars.startRaise();
    // Never lower the Top-Hat below the safe depth (seabed under the launch point).
    if (lars.state === 'lowering') lars.depth = safeTmsDepth(lars.depth);

    // Top-Hat / main umbilical.
    this.env.current(lars.position, this.tmpC);
    const released = lars.state === 'released';
    this.tmpPull.copy(this.tether.force).multiplyScalar(released ? -1 : 0);
    lars.update(dt, this.tmpC, this.tmpPull);
    if (!released) {
      // Latched: held mechanically under the TMS (no free motion).
      rov.kinematic = true;
      rov.kinematicYaw = lars.yaw;
      lars.dockPosition(rov.kinematicTarget);
    }

    // Tether between the TMS exit guide and the ROV termination.
    this.tether.anchor.copy(this.tmsExit);
    this.tether.enabled = released;
    if (released) this.tms.update(dt, this.tether.chordLength, this.tether.tension);
    else this.tms.reset(this.tms.config.minLength, this.tms.mode);
    this.tether.payout = this.tms.payout;
    this.tether.setVehicle(rov.position, rov.orientation);

    // Pilot → controller → thrusters (thrusters also run on deck for the pre-dive check).
    this.controller.update(this.command, dt);
    rov.step(dt, this.env);
    // The tether was stepped at the start-of-step pose: put its termination node
    // on the integrated attach point (rendered end = physical termination).
    if (released && this.tether.enabled) this.tether.syncAttach(this.attachWorld(this.tmp));

    // Docking capture (position, alignment, relative speed, tether hauled in).
    if (released) {
      const vw = rov.worldVelocity(this.tmpC);
      const cap = lars.checkCapture(rov.position, rov.orientation, vw, rov.heading, this.tms.payout);
      if (cap.ok && lars.latch()) {
        this.latchRigid = false; // smooth latch pull-in from the capture position
        this.tether.enabled = false;
        this.tms.reset(this.tms.config.minLength, this.tms.mode); // keep the pilot's winch mode
        this.controller.reset();
        this.events.docked = true;
      }
    }

    if (lars.state !== 'released') {
      const dock = lars.dockPosition(this.tmpC);
      // Rigid once the rate-limited pull-in has converged in position AND heading
      // (the final snap is then < 0.5 mm / 0.06°: no visible jump).
      if (!this.latchRigid && rov.position.distanceTo(dock) < 0.0005) {
        this.tmpPull.set(0, 1, 0);
        const yawErr = 2 * Math.acos(Math.min(1, Math.abs(rov.orientation.dot(this.tmpQ.setFromAxisAngle(this.tmpPull, lars.yaw)))));
        if (yawErr < 0.001) this.latchRigid = true;
      }
      if (this.latchRigid) {
        rov.position.copy(dock);
        rov.velocity.set(0, 0, 0);
        rov.orientation.setFromAxisAngle(this.tmpPull.set(0, 1, 0), lars.yaw);
        rov.angularVelocity.set(0, 0, 0);
      }
    }

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
      tms: {
        mode: this.tms.mode,
        command: this.tms.command,
        state: this.tms.state,
        payout: this.tms.payout,
        speed: this.tms.speed,
        tension: this.tether.tension,
        slack: this.tether.slack,
        chord: this.tether.chordLength,
        tensionWarn: this.tms.config.tensionWarn,
        slackWarn: this.tms.config.slackWarn,
      },
      commanding: Math.abs(c.surge) + Math.abs(c.sway) + Math.abs(c.heave) + Math.abs(c.yaw) > 0.05,
      craneReleased: this.lars.state === 'released',
      craneOnDeck: this.lars.state === 'onDeck',
      docked: this.lars.state === 'atDepth',
      lars: this.lars.state,
    });
  }

  /** Umbilical length paid out (m), straight-line approximation with slack. */
  tetherOut(): number {
    return this.tms.payout;
  }
}
