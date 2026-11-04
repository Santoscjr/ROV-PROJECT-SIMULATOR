export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
  /** Absolute limit of the integral contribution (anti-windup). */
  iLimit: number;
  /** Absolute output limit. */
  outLimit: number;
}

/** PID with derivative-on-measurement and clamped integrator. */
export class Pid {
  private integral = 0;
  private lastMeasurement: number | null = null;
  constructor(public gains: PidGains) {}

  reset(): void {
    this.integral = 0;
    this.lastMeasurement = null;
  }

  /**
   * @param error setpoint − measurement
   * @param measurement current measurement (for the derivative term)
   * @param rate optional measured derivative (overrides finite difference)
   */
  update(error: number, measurement: number, dt: number, rate?: number): number {
    const g = this.gains;
    const d = rate ?? (this.lastMeasurement === null ? 0 : (measurement - this.lastMeasurement) / dt);
    this.lastMeasurement = measurement;
    this.integral = clamp(this.integral + g.ki * error * dt, -g.iLimit, g.iLimit);
    return clamp(g.kp * error + this.integral - g.kd * d, -g.outLimit, g.outLimit);
  }

  get integralTerm(): number {
    return this.integral;
  }
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Shortest signed angle difference a − b in degrees, in (−180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
