import type { ThrusterSpec } from './rovParams';

/**
 * Generalised force in the body frame, ordered
 * [Fx (surge), Fy (heave), Fz (sway), Tx (roll), Ty (yaw, + = turn to port), Tz (pitch, + = nose up)].
 */
export type Wrench = [number, number, number, number, number, number];

export const zeroWrench = (): Wrench => [0, 0, 0, 0, 0, 0];

/** 6×N thruster configuration matrix: column i maps thruster force (N) to body wrench. */
export function configurationMatrix(thrusters: readonly ThrusterSpec[]): number[][] {
  const B: number[][] = Array.from({ length: 6 }, () => new Array(thrusters.length).fill(0));
  thrusters.forEach((t, i) => {
    const [px, py, pz] = t.position;
    const [dx, dy, dz] = t.direction;
    B[0][i] = dx;
    B[1][i] = dy;
    B[2][i] = dz;
    // r × d
    B[3][i] = py * dz - pz * dy;
    B[4][i] = pz * dx - px * dz;
    B[5][i] = px * dy - py * dx;
  });
  return B;
}

/** Gauss–Jordan inverse of a small square matrix. Throws if singular. */
export function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-12) throw new Error('singular matrix');
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const inv = 1 / a[c][c];
    for (let k = 0; k < 2 * n; k++) a[c][k] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Moore–Penrose pseudo-inverse for a full-row-rank 6×N matrix: Bᵀ(BBᵀ)⁻¹. */
export function pseudoInverse(B: number[][]): number[][] {
  const rows = B.length;
  const cols = B[0].length;
  const BBt: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: rows }, (_, j) => {
      let s = 0;
      for (let k = 0; k < cols; k++) s += B[i][k] * B[j][k];
      return s;
    }),
  );
  const inv = invert(BBt);
  return Array.from({ length: cols }, (_, k) =>
    Array.from({ length: rows }, (_, j) => {
      let s = 0;
      for (let i = 0; i < rows; i++) s += B[i][k] * inv[i][j];
      return s;
    }),
  );
}

/**
 * Thrust allocation: converts a demanded body wrench into individual thruster
 * forces, respecting each thruster's forward/reverse limit. When the demand
 * exceeds the available thrust the whole solution is scaled down so the
 * direction of the wrench is preserved (the vehicle does not "skid" sideways
 * just because one thruster saturated).
 */
export class ThrustAllocator {
  readonly B: number[][];
  readonly Binv: number[][];
  /** Maximum achievable magnitude along each pure wrench axis. */
  readonly capacity: Wrench;
  /**
   * Fraction of the last demanded wrench actually allocated (1 = feasible,
   * < 1 = the demand was scaled down because a thruster saturated). Used by
   * the controller for integrator anti-windup.
   */
  lastScale = 1;

  constructor(readonly thrusters: readonly ThrusterSpec[]) {
    this.B = configurationMatrix(thrusters);
    this.Binv = pseudoInverse(this.B);
    const cap = zeroWrench();
    for (let axis = 0; axis < 6; axis++) {
      let worst = 0;
      for (let i = 0; i < thrusters.length; i++) {
        const u = this.Binv[i][axis];
        const lim = u >= 0 ? thrusters[i].maxForward : thrusters[i].maxReverse;
        worst = Math.max(worst, Math.abs(u) / lim);
      }
      cap[axis] = worst > 0 ? 1 / worst : 0;
    }
    this.capacity = cap;
  }

  /** Returns thruster forces (N). `out` is reused when given. */
  allocate(tau: Readonly<Wrench>, out: number[] = new Array(this.thrusters.length).fill(0)): number[] {
    let scale = 1;
    for (let i = 0; i < this.thrusters.length; i++) {
      let f = 0;
      for (let j = 0; j < 6; j++) f += this.Binv[i][j] * tau[j];
      out[i] = f;
      const lim = f >= 0 ? this.thrusters[i].maxForward : this.thrusters[i].maxReverse;
      scale = Math.max(scale, Math.abs(f) / lim);
    }
    if (scale > 1) for (let i = 0; i < out.length; i++) out[i] /= scale;
    this.lastScale = 1 / scale;
    return out;
  }

  /** Body wrench produced by a set of thruster forces. */
  wrenchOf(forces: readonly number[], out: Wrench = zeroWrench()): Wrench {
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let i = 0; i < forces.length; i++) s += this.B[j][i] * forces[i];
      out[j] = s;
    }
    return out;
  }
}

/** Defaults for the optional thruster parameters (see ThrusterSpec). */
export const THRUSTER_DEFAULTS = { slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 } as const;

/**
 * Thruster bank dynamics (v2.0). Per thruster:
 *  - state n = propeller speed as a fraction of rated speed, [-1, 1];
 *  - the force command is converted open-loop into a speed set-point
 *    n* = sign(F)·sqrt(|F| / Fmax), Fmax = forward or reverse limit;
 *  - the motor follows n* with a first-order lag (spec.timeConstant) and a
 *    slew-rate limit (spec.slewRate), so thrust ∝ n|n| rises in an S-shape;
 *  - advance loss: T = Fmax·(n² − |n|·u_a / V_a) with u_a the inflow speed
 *    along the thrust direction (linear K_T(J) approximation), clamped to
 *    [0, 1.15·Fmax·n²] (a small gain when thrusting against the inflow);
 *  - power ∝ |n|³ (P = maxPower·|n|³). The whole bank shares one power
 *    budget (HPU limit): commands are scaled uniformly so the steady-state
 *    power fits (wrench direction preserved) and, during transients, all
 *    speeds are scaled down together if the budget is exceeded (pump flow
 *    limit / pressure droop).
 * All figures are plausible approximations, not data of a real thruster.
 */
export class ThrusterBank {
  /** Actual thrust of each thruster (N, signed along its direction). */
  readonly force: number[];
  /** Force command as requested by the controller (N). */
  readonly command: number[];
  /** Force command after the power-budget scaling (N). */
  readonly limitedCommand: number[];
  /** Propeller speed, fraction of rated speed [-1, 1]. */
  readonly speed: number[];
  /**
   * Inflow speed of the water through each thruster along its +direction
   * (m/s), i.e. (vehicle velocity relative to water)·direction. Set by
   * RovPhysics before each step; 0 means bollard condition.
   */
  readonly inflow: number[];
  /** Power budget shared by all thrusters (W). */
  readonly powerBudget: number;
  /** Uniform scale applied to the last command set by the power budget (1 = not limited). */
  powerScale = 1;
  /** Total power drawn now (W). */
  power = 0;
  private readonly nTarget: number[];
  private readonly fMaxF: number[];
  private readonly fMaxR: number[];
  private readonly pMax: number[];
  private readonly slew: number[];
  private readonly vAdv: number[];
  private readonly alpha: number[];
  private alphaDt = -1;

  constructor(
    readonly thrusters: readonly ThrusterSpec[],
    powerBudget = Infinity,
  ) {
    const z = () => thrusters.map(() => 0);
    this.force = z();
    this.command = z();
    this.limitedCommand = z();
    this.speed = z();
    this.inflow = z();
    this.nTarget = z();
    this.alpha = z();
    this.fMaxF = thrusters.map((t) => t.maxForward);
    this.fMaxR = thrusters.map((t) => t.maxReverse);
    this.pMax = thrusters.map((t) => t.maxPower ?? THRUSTER_DEFAULTS.maxPower);
    this.slew = thrusters.map((t) => t.slewRate ?? THRUSTER_DEFAULTS.slewRate);
    this.vAdv = thrusters.map((t) => t.advanceSpeed ?? THRUSTER_DEFAULTS.advanceSpeed);
    this.powerBudget = powerBudget > 0 ? powerBudget : Infinity;
  }

  setCommand(forces: readonly number[]): void {
    const n = this.command.length;
    let p = 0;
    for (let i = 0; i < n; i++) {
      const f = forces[i] ?? 0;
      this.command[i] = f;
      const r = Math.min(1, Math.abs(f) / (f >= 0 ? this.fMaxF[i] : this.fMaxR[i]));
      p += this.pMax[i] * r * Math.sqrt(r); // |n|³ = r^1.5
    }
    // Scaling forces by s scales n by √s and power by s^1.5.
    const s = p > this.powerBudget ? Math.pow(this.powerBudget / p, 2 / 3) : 1;
    this.powerScale = s;
    for (let i = 0; i < n; i++) {
      const f = this.command[i] * s;
      this.limitedCommand[i] = f;
      const r = Math.min(1, Math.abs(f) / (f >= 0 ? this.fMaxF[i] : this.fMaxR[i]));
      this.nTarget[i] = f >= 0 ? Math.sqrt(r) : -Math.sqrt(r);
    }
  }

  step(dt: number, enabled = true): void {
    const n = this.speed;
    const len = n.length;
    if (dt !== this.alphaDt) {
      for (let i = 0; i < len; i++) this.alpha[i] = 1 - Math.exp(-dt / Math.max(1e-3, this.thrusters[i].timeConstant));
      this.alphaDt = dt;
    }
    let p = 0;
    for (let i = 0; i < len; i++) {
      const target = enabled ? this.nTarget[i] : 0;
      const maxStep = this.slew[i] * dt;
      let dn = (target - n[i]) * this.alpha[i];
      if (dn > maxStep) dn = maxStep;
      else if (dn < -maxStep) dn = -maxStep;
      n[i] += dn;
      const a = Math.abs(n[i]);
      p += this.pMax[i] * a * a * a;
    }
    if (p > this.powerBudget) {
      const k = Math.cbrt(this.powerBudget / p);
      for (let i = 0; i < len; i++) n[i] *= k;
      p = this.powerBudget;
    }
    this.power = p;
    for (let i = 0; i < len; i++) {
      const ni = n[i];
      const a = Math.abs(ni);
      if (a < 1e-6) {
        this.force[i] = 0;
        continue;
      }
      const fMax = ni >= 0 ? this.fMaxF[i] : this.fMaxR[i];
      // Advance speed along the direction the thruster is pushing the vehicle.
      const ua = ni >= 0 ? this.inflow[i] : -this.inflow[i];
      let k = 1 - ua / (a * this.vAdv[i]);
      if (k < 0) k = 0;
      else if (k > 1.15) k = 1.15;
      const t = fMax * a * a * k;
      this.force[i] = ni >= 0 ? t : -t;
    }
  }

  /** Output as fraction of the thruster's limit in its current direction, [-1, 1]. */
  level(i: number): number {
    const f = this.force[i];
    const t = this.thrusters[i];
    return f >= 0 ? f / t.maxForward : f / t.maxReverse;
  }

  /** Power drawn by thruster i as a fraction of its own rated power, [0, 1]. */
  load(i: number): number {
    const a = Math.abs(this.speed[i]);
    return a * a * a;
  }

  /** Total power as a fraction of the shared budget [0, 1] (of the summed ratings if unlimited). */
  get powerFraction(): number {
    if (Number.isFinite(this.powerBudget)) return Math.min(1, this.power / this.powerBudget);
    let s = 0;
    for (const p of this.pMax) s += p;
    return s > 0 ? this.power / s : 0;
  }

  reset(): void {
    this.force.fill(0);
    this.command.fill(0);
    this.limitedCommand.fill(0);
    this.speed.fill(0);
    this.nTarget.fill(0);
    this.inflow.fill(0);
    this.powerScale = 1;
    this.power = 0;
  }
}
