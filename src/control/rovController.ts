import type { AxisCommand } from '../input/types';
import type { RovPhysics } from '../physics/rovPhysics';
import { ThrustAllocator, zeroWrench, type Wrench } from '../physics/thrusters';
import { Pid, angleDiffDeg, clamp } from './pid';

/**
 * Pilot assistance modes, modelled after the behaviour documented for
 * ArduSub (Manual / Stabilize / Depth Hold):
 *  - MANUAL: stick commands map directly to thrust; only passive (buoyancy)
 *    roll/pitch stability.
 *  - STABILIZE: active roll/pitch levelling with the vertical thrusters and
 *    heading hold; the yaw stick commands a turn rate.
 *  - DEPTH_HOLD: STABILIZE plus closed-loop depth control; the heave stick
 *    commands climb/descend and the new depth is held when released.
 */
export type PilotMode = 'manual' | 'stabilize' | 'depthHold';
export const PILOT_MODES: PilotMode[] = ['manual', 'stabilize', 'depthHold'];

export interface ControllerStatus {
  mode: PilotMode;
  headingSetpoint: number | null;
  depthSetpoint: number | null;
  /** Demanded wrench as a fraction of capacity per axis. */
  demand: Wrench;
}

const DEG = Math.PI / 180;

export interface ControllerTuning {
  /** Fraction of yaw torque capacity available to the pilot (turn-rate limit). */
  yawAuthority: number;
  /** Max commanded turn rate in assisted modes (deg/s). */
  maxTurnRate: number;
  /** Max attitude setpoint from pitch/roll sticks in assisted modes (deg). */
  maxAttitude: number;
}

export const DEFAULT_TUNING: ControllerTuning = { yawAuthority: 0.45, maxTurnRate: 40, maxAttitude: 15 };

export class RovController {
  readonly allocator: ThrustAllocator;
  mode: PilotMode = 'stabilize';
  headingSetpoint: number | null = null;
  depthSetpoint: number | null = null;
  private readonly demand: Wrench = zeroWrench();
  private readonly tau: Wrench = zeroWrench();
  private readonly forces: number[];
  private readonly yawRatePid = new Pid({ kp: 90, ki: 25, kd: 0, iLimit: 900, outLimit: 1e9 });
  private readonly depthPid = new Pid({ kp: 2600, ki: 260, kd: 6500, iLimit: 1400, outLimit: 1e9 });
  private readonly pitchPid = new Pid({ kp: 140, ki: 10, kd: 90, iLimit: 400, outLimit: 1e9 });
  private readonly rollPid = new Pid({ kp: 140, ki: 10, kd: 90, iLimit: 400, outLimit: 1e9 });

  constructor(
    private readonly rov: RovPhysics,
    public tuning: ControllerTuning = DEFAULT_TUNING,
  ) {
    this.allocator = new ThrustAllocator(rov.params.thrusters);
    this.forces = rov.params.thrusters.map(() => 0);
  }

  setMode(mode: PilotMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.headingSetpoint = mode === 'manual' ? null : this.rov.heading;
    this.depthSetpoint = mode === 'depthHold' ? this.rov.depth : null;
    this.yawRatePid.reset();
    this.depthPid.reset();
    this.pitchPid.reset();
    this.rollPid.reset();
  }

  reset(): void {
    this.headingSetpoint = this.mode === 'manual' ? null : this.rov.heading;
    this.depthSetpoint = this.mode === 'depthHold' ? this.rov.depth : null;
    this.yawRatePid.reset();
    this.depthPid.reset();
    this.pitchPid.reset();
    this.rollPid.reset();
    this.forces.fill(0);
    this.rov.thrusters.setCommand(this.forces);
  }

  /** Compute thruster commands for one physics step. */
  update(cmd: Readonly<AxisCommand>, dt: number): void {
    const rov = this.rov;
    const cap = this.allocator.capacity;
    const tau = this.tau;
    const assisted = this.mode !== 'manual' && rov.submerged > 0.95;

    tau[0] = clamp(cmd.surge, -1, 1) * cap[0];
    tau[1] = clamp(cmd.heave, -1, 1) * cap[1];
    tau[2] = clamp(cmd.sway, -1, 1) * cap[2];
    tau[3] = 0;
    tau[4] = 0;
    tau[5] = 0;

    if (!assisted) {
      tau[3] = clamp(cmd.roll, -1, 1) * cap[3] * 0.5;
      tau[4] = -clamp(cmd.yaw, -1, 1) * cap[4] * this.tuning.yawAuthority;
      tau[5] = clamp(cmd.pitch, -1, 1) * cap[5] * 0.5;
      this.headingSetpoint = null;
      if (this.mode !== 'depthHold') this.depthSetpoint = null;
    } else {
      // --- Attitude (roll / pitch) levelling with the vertical thrusters.
      const w = rov.angularVelocity;
      const pitchSet = clamp(cmd.pitch, -1, 1) * this.tuning.maxAttitude;
      const rollSet = clamp(cmd.roll, -1, 1) * this.tuning.maxAttitude;
      // Gains in N·m per degree; rates measured by the gyro (body ω).
      tau[5] = clamp(this.pitchPid.update(pitchSet - rov.pitch, rov.pitch, dt, w.z / DEG), -cap[5], cap[5]);
      tau[3] = clamp(this.rollPid.update(rollSet - rov.roll, rov.roll, dt, w.x / DEG), -cap[3], cap[3]);

      // --- Heading: stick = turn-rate demand; released = hold heading.
      const yawRate = rov.yawRate;
      let rateCmd: number;
      if (Math.abs(cmd.yaw) > 0.02) {
        rateCmd = clamp(cmd.yaw, -1, 1) * this.tuning.maxTurnRate;
        this.headingSetpoint = null;
      } else {
        if (this.headingSetpoint === null && Math.abs(yawRate) < 4) this.headingSetpoint = rov.heading;
        rateCmd = this.headingSetpoint === null ? 0 : clamp(angleDiffDeg(this.headingSetpoint, rov.heading) * 1.2, -25, 25);
      }
      const yawCap = cap[4] * this.tuning.yawAuthority * 1.4;
      const turnRight = this.yawRatePid.update(rateCmd - yawRate, yawRate, dt, 0) + rateCmd * 20;
      tau[4] = -clamp(turnRight, -yawCap, yawCap);

      // --- Depth hold.
      if (this.mode === 'depthHold') {
        const vz = rov.worldVelocity().y; // + up
        if (Math.abs(cmd.heave) > 0.05) {
          // Pilot is climbing / descending: pass-through, keep the learned bias.
          tau[1] = clamp(cmd.heave, -1, 1) * cap[1] - this.depthPid.integralTerm;
          this.depthSetpoint = null;
        } else {
          if (this.depthSetpoint === null && Math.abs(vz) < 0.15) this.depthSetpoint = rov.depth;
          if (this.depthSetpoint !== null) {
            const err = this.depthSetpoint - rov.depth; // + => must go down
            const down = this.depthPid.update(err, rov.depth, dt, -vz);
            tau[1] = clamp(-down, -cap[1], cap[1]);
          } else {
            // Braking the vertical motion before latching the new setpoint.
            tau[1] = clamp(-vz * 6500 - this.depthPid.integralTerm, -cap[1], cap[1]);
          }
        }
      }
    }

    for (let i = 0; i < 6; i++) this.demand[i] = cap[i] > 0 ? tau[i] / cap[i] : 0;
    this.allocator.allocate(tau, this.forces);
    rov.thrusters.setCommand(this.forces);
  }

  status(): ControllerStatus {
    return {
      mode: this.mode,
      headingSetpoint: this.headingSetpoint,
      depthSetpoint: this.depthSetpoint,
      demand: [...this.demand] as Wrench,
    };
  }
}
