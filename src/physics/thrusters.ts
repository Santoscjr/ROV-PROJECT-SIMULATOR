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

/** First-order thruster response (motor + propeller spin-up). */
export class ThrusterBank {
  readonly force: number[];
  readonly command: number[];
  constructor(readonly thrusters: readonly ThrusterSpec[]) {
    this.force = thrusters.map(() => 0);
    this.command = thrusters.map(() => 0);
  }
  setCommand(forces: readonly number[]): void {
    for (let i = 0; i < this.command.length; i++) this.command[i] = forces[i] ?? 0;
  }
  step(dt: number, enabled = true): void {
    for (let i = 0; i < this.force.length; i++) {
      const target = enabled ? this.command[i] : 0;
      const a = 1 - Math.exp(-dt / this.thrusters[i].timeConstant);
      this.force[i] += (target - this.force[i]) * a;
    }
  }
  /** Output as fraction of the thruster's limit in its current direction, [-1, 1]. */
  level(i: number): number {
    const f = this.force[i];
    const t = this.thrusters[i];
    return f >= 0 ? f / t.maxForward : f / t.maxReverse;
  }
  reset(): void {
    this.force.fill(0);
    this.command.fill(0);
  }
}
