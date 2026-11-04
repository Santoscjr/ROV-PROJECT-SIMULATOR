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
 *
 * v2.0 additions:
 *  - bumpless transfer: the assisted contribution of each channel (attitude
 *    + heading, heave) is blended with the manual pass-through by an
 *    authority factor that ramps over `rampTime` (0.5 s) when a mode is
 *    entered or left; setpoints are only latched when the vehicle is nearly
 *    still on that axis (otherwise it is braked first and latched later);
 *    the learned buoyancy bias of the depth loop survives mode changes;
 *  - anti-windup: integrators freeze (conditional integration) when the
 *    output on that axis is clamped, when the allocator / power budget had
 *    to scale the demand down, or (depth) when resting on the seabed, and
 *    the error would push further into saturation;
 *  - heading capture with a turn-rate lead so the held heading is where the
 *    vehicle actually stops (no swing-back).
 */
export type PilotMode = 'manual' | 'stabilize' | 'depthHold';
export const PILOT_MODES: PilotMode[] = ['manual', 'stabilize', 'depthHold'];

export interface ControllerStatus {
  mode: PilotMode;
  headingSetpoint: number | null;
  depthSetpoint: number | null;
  /** Demanded wrench as a fraction of capacity per axis. */
  demand: Wrench;
  /** Authority of the attitude/heading assist (0..1, ramps at mode changes). */
  assistAttitude: number;
  /** Authority of the depth assist (0..1, ramps at mode changes). */
  assistDepth: number;
  /**
   * Fraction of the demanded wrench the thrusters can deliver (allocator ×
   * power budget), 1 = not saturated.
   */
  saturation: number;
}

const DEG = Math.PI / 180;

export interface ControllerTuning {
  /** Fraction of yaw torque capacity available to the pilot (turn-rate limit). */
  yawAuthority: number;
  /** Max commanded turn rate in assisted modes (deg/s). */
  maxTurnRate: number;
  /** Max attitude setpoint from pitch/roll sticks in assisted modes (deg). */
  maxAttitude: number;
  /** Time for an assist channel to ramp fully in or out at a mode change (s). */
  rampTime?: number;
}

export const DEFAULT_TUNING: ControllerTuning = { yawAuthority: 0.45, maxTurnRate: 40, maxAttitude: 15, rampTime: 0.5 };

/** Turn rate (deg/s) below which the heading is captured after the stick is released. */
const CAPTURE_RATE = 4;
/** Lead (s) applied to the captured heading: where the vehicle will stop. */
const CAPTURE_LEAD = 0.35;
/** Vertical speed (m/s) below which the depth is latched. */
const LATCH_VZ = 0.15;

const sameSign = (a: number, b: number) => (a > 0 && b > 0) || (a < 0 && b < 0);

export class RovController {
  readonly allocator: ThrustAllocator;
  mode: PilotMode = 'stabilize';
  headingSetpoint: number | null = null;
  depthSetpoint: number | null = null;
  /** Current assist authorities (0..1). */
  assistAttitude = 0;
  assistDepth = 0;
  private readonly demand: Wrench = zeroWrench();
  private readonly tau: Wrench = zeroWrench();
  private readonly forces: number[];
  private readonly yawRatePid = new Pid({ kp: 90, ki: 25, kd: 0, iLimit: 900, outLimit: 1e9 });
  private readonly depthPid = new Pid({ kp: 2600, ki: 260, kd: 6500, iLimit: 1400, outLimit: 1e9 });
  private readonly pitchPid = new Pid({ kp: 140, ki: 10, kd: 90, iLimit: 400, outLimit: 1e9 });
  private readonly rollPid = new Pid({ kp: 140, ki: 10, kd: 90, iLimit: 400, outLimit: 1e9 });
  /** Saturation flags of the previous step, per wrench axis (output clamp). */
  private readonly clamped = [false, false, false, false, false, false];
  /** Raw (unclamped) loop outputs of the previous step, in each PID's own sign. */
  private readonly lastRaw = [0, 0, 0, 0, 0, 0];
  private saturation = 1;
  private initialised = false;

  constructor(
    private readonly rov: RovPhysics,
    public tuning: ControllerTuning = DEFAULT_TUNING,
  ) {
    this.allocator = new ThrustAllocator(rov.params.thrusters);
    this.forces = rov.params.thrusters.map(() => 0);
  }

  private get assistsAttitude(): boolean {
    return this.mode !== 'manual';
  }

  setMode(mode: PilotMode): void {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode !== 'manual' && prev === 'manual') this.captureHeading();
    if (mode === 'depthHold') this.latchDepth();
    else this.depthSetpoint = null;
    if (mode === 'manual') this.headingSetpoint = null;
  }

  /** Hard reset (launch, scenario reset): no ramps, fresh integrators. */
  reset(): void {
    this.yawRatePid.reset();
    this.depthPid.reset();
    this.pitchPid.reset();
    this.rollPid.reset();
    this.headingSetpoint = null;
    this.depthSetpoint = null;
    if (this.assistsAttitude) this.captureHeading();
    if (this.mode === 'depthHold') this.latchDepth();
    this.assistAttitude = this.assistsAttitude ? 1 : 0;
    this.assistDepth = this.mode === 'depthHold' ? 1 : 0;
    this.clamped.fill(false);
    this.lastRaw.fill(0);
    this.saturation = 1;
    this.initialised = true;
    this.forces.fill(0);
    this.rov.thrusters.setCommand(this.forces);
  }

  private captureHeading(): void {
    const rate = this.rov.yawRate;
    this.headingSetpoint = Math.abs(rate) < CAPTURE_RATE ? (this.rov.heading + rate * CAPTURE_LEAD + 360) % 360 : null;
  }

  private latchDepth(): void {
    this.depthSetpoint = Math.abs(this.rov.worldVelocity().y) < LATCH_VZ ? this.rov.depth : null;
  }

  /** Compute thruster commands for one physics step. */
  update(cmd: Readonly<AxisCommand>, dt: number): void {
    const rov = this.rov;
    if (!this.initialised) {
      // First use without reset(): start with the mode fully engaged (v1 behaviour).
      this.assistAttitude = this.assistsAttitude ? 1 : 0;
      this.assistDepth = this.mode === 'depthHold' ? 1 : 0;
      if (this.assistsAttitude && this.headingSetpoint === null) this.captureHeading();
      if (this.mode === 'depthHold' && this.depthSetpoint === null) this.latchDepth();
      this.initialised = true;
    }
    const cap = this.allocator.capacity;
    const tau = this.tau;
    const submerged = rov.submerged > 0.95;
    const ramp = dt / Math.max(1e-3, this.tuning.rampTime ?? 0.5);

    // --- Assist authority ramps (bumpless transfer).
    const attTarget = this.assistsAttitude && submerged ? 1 : 0;
    const depTarget = this.mode === 'depthHold' && submerged ? 1 : 0;
    this.assistAttitude = clamp(this.assistAttitude + clamp(attTarget - this.assistAttitude, -ramp, ramp), 0, 1);
    this.assistDepth = clamp(this.assistDepth + clamp(depTarget - this.assistDepth, -ramp, ramp), 0, 1);
    const aA = this.assistAttitude;
    const aD = this.assistDepth;

    // Saturation feedback from the previous allocation (allocator × HPU budget).
    const globalSat = this.saturation < 0.98;

    // --- Pilot pass-through (MANUAL mapping).
    tau[0] = clamp(cmd.surge, -1, 1) * cap[0];
    tau[1] = clamp(cmd.heave, -1, 1) * cap[1];
    tau[2] = clamp(cmd.sway, -1, 1) * cap[2];
    tau[3] = clamp(cmd.roll, -1, 1) * cap[3] * 0.5;
    tau[4] = -clamp(cmd.yaw, -1, 1) * cap[4] * this.tuning.yawAuthority;
    tau[5] = clamp(cmd.pitch, -1, 1) * cap[5] * 0.5;

    // --- Attitude + heading assist.
    if (aA > 0) {
      const w = rov.angularVelocity;
      const pitchSet = clamp(cmd.pitch, -1, 1) * this.tuning.maxAttitude;
      const rollSet = clamp(cmd.roll, -1, 1) * this.tuning.maxAttitude;
      // Gains in N·m per degree; rates measured by the gyro (body ω).
      const ePitch = pitchSet - rov.pitch;
      const eRoll = rollSet - rov.roll;
      const iPitch = (this.clamped[5] || globalSat) && sameSign(ePitch, this.lastRaw[5]) ? 0 : aA;
      const iRoll = (this.clamped[3] || globalSat) && sameSign(eRoll, this.lastRaw[3]) ? 0 : aA;
      const pitchRaw = this.pitchPid.update(ePitch, rov.pitch, dt, w.z / DEG, iPitch);
      const rollRaw = this.rollPid.update(eRoll, rov.roll, dt, w.x / DEG, iRoll);
      const pitchOut = clamp(pitchRaw, -cap[5], cap[5]);
      const rollOut = clamp(rollRaw, -cap[3], cap[3]);
      this.clamped[5] = pitchOut !== pitchRaw;
      this.clamped[3] = rollOut !== rollRaw;
      this.lastRaw[5] = pitchRaw;
      this.lastRaw[3] = rollRaw;

      // Heading: stick = turn-rate demand; released = brake, capture, hold.
      const yawRate = rov.yawRate;
      let rateCmd: number;
      if (Math.abs(cmd.yaw) > 0.02) {
        rateCmd = clamp(cmd.yaw, -1, 1) * this.tuning.maxTurnRate;
        this.headingSetpoint = null;
      } else {
        if (this.headingSetpoint === null && Math.abs(yawRate) < CAPTURE_RATE) this.captureHeading();
        rateCmd = this.headingSetpoint === null ? 0 : clamp(angleDiffDeg(this.headingSetpoint, rov.heading) * 1.2, -25, 25);
      }
      const yawCap = cap[4] * this.tuning.yawAuthority * 1.4;
      const eRate = rateCmd - yawRate;
      const iYaw = (this.clamped[4] || globalSat) && sameSign(eRate, this.lastRaw[4]) ? 0 : aA;
      // Feed-forward of the hydrodynamic yaw damping at the demanded rate, so
      // the integrator only carries disturbances (it would otherwise hold a
      // large turning bias at release and swing the vehicle past the capture).
      const r = rateCmd * DEG;
      const ff = rov.params.linDampRot[1] * r + rov.params.quadDampRot[1] * Math.abs(r) * r;
      const turnRight = this.yawRatePid.update(eRate, yawRate, dt, 0, iYaw) + ff;
      const yawOut = clamp(turnRight, -yawCap, yawCap);
      this.clamped[4] = yawOut !== turnRight;
      this.lastRaw[4] = turnRight;

      tau[3] += (rollOut - tau[3]) * aA;
      tau[4] += (-yawOut - tau[4]) * aA;
      tau[5] += (pitchOut - tau[5]) * aA;
    } else {
      // Fully manual: fresh attitude loops for the next engagement.
      this.yawRatePid.reset();
      this.pitchPid.reset();
      this.rollPid.reset();
      this.headingSetpoint = null;
      this.clamped[3] = this.clamped[4] = this.clamped[5] = false;
      this.lastRaw[3] = this.lastRaw[4] = this.lastRaw[5] = 0;
    }

    // --- Depth assist.
    if (aD > 0) {
      const vz = rov.worldVelocity().y; // + up
      const bias = -this.depthPid.integralTerm; // learned buoyancy compensation (+ = up)
      let heaveOut: number;
      if (Math.abs(cmd.heave) > 0.05) {
        // Pilot is climbing / descending: pass-through + learned bias, no fight.
        heaveOut = clamp(clamp(cmd.heave, -1, 1) * cap[1] + bias, -cap[1], cap[1]);
        this.depthSetpoint = null;
        this.clamped[1] = false;
      } else {
        if (this.depthSetpoint === null && Math.abs(vz) < LATCH_VZ) this.depthSetpoint = rov.depth;
        if (this.depthSetpoint !== null) {
          const err = this.depthSetpoint - rov.depth; // + => must go down
          // On the seabed and asked to go deeper: integrating would only wind up.
          const grounded = rov.contactCount > 0 && err > 0;
          const satHere = this.clamped[1] || globalSat;
          const iDepth = grounded || (satHere && sameSign(err, this.lastRaw[1])) ? 0 : aD;
          const down = this.depthPid.update(err, rov.depth, dt, -vz, iDepth);
          heaveOut = clamp(-down, -cap[1], cap[1]);
          this.clamped[1] = heaveOut !== -down;
          this.lastRaw[1] = down;
        } else {
          // Braking the vertical motion before latching the new setpoint.
          heaveOut = clamp(-vz * 6500 + bias, -cap[1], cap[1]);
          this.clamped[1] = false;
        }
      }
      tau[1] += (heaveOut - tau[1]) * aD;
    } else {
      this.depthSetpoint = null;
      this.clamped[1] = false;
    }

    for (let i = 0; i < 6; i++) this.demand[i] = cap[i] > 0 ? tau[i] / cap[i] : 0;
    this.allocator.allocate(tau, this.forces);
    rov.thrusters.setCommand(this.forces);
    this.saturation = this.allocator.lastScale * rov.thrusters.powerScale;
  }

  status(): ControllerStatus {
    return {
      mode: this.mode,
      headingSetpoint: this.headingSetpoint,
      depthSetpoint: this.depthSetpoint,
      demand: [...this.demand] as Wrench,
      assistAttitude: this.assistAttitude,
      assistDepth: this.assistDepth,
      saturation: this.saturation,
    };
  }
}
