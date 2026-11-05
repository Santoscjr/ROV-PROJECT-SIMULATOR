/**
 * Tether Management System winch (training approximation).
 *
 * A drum stores the tether; a hydraulic drive pays out or hauls in at a
 * limited, ramped speed. In AUTO the winch keeps a working slack (similar in
 * intent to the auto-payout/constant-tension modes found on many systems); in
 * MANUAL the pilot commands PAY / HAUL / STOP. Protections: length limits
 * (physical end of cable / minimum turns on the drum), haul inhibited above
 * the tension limit, and a slipping brake that lets cable out under severe
 * overload instead of breaking it. Values are fictitious but plausible.
 */

export type TmsCommand = 'pay' | 'haul' | 'stop';
export type TmsMode = 'manual' | 'auto';
export type TmsState = 'stop' | 'pay' | 'haul' | 'auto' | 'limitMin' | 'limitMax' | 'tensionTrip' | 'slip';

export interface TmsConfig {
  /** Tether capacity on the drum = maximum payout (m). */
  maxLength: number;
  /** Minimum payout: cable that always stays outside (m). */
  minLength: number;
  payRate: number;
  haulRate: number;
  /** Drive acceleration (m/s²). */
  accel: number;
  /** Tension warning / haul-inhibit limit / brake slip (N). */
  tensionWarn: number;
  tensionLimit: number;
  slipTension: number;
  /** Slack warning threshold (m) and AUTO target slack (m + fraction of distance). */
  slackWarn: number;
  autoSlack: number;
  autoSlackFraction: number;
  /** Drum core / full radius (m) for the rotation and stored-cable display. */
  drumCoreRadius: number;
  drumFullRadius: number;
}

export const DEFAULT_TMS: TmsConfig = {
  maxLength: 300,
  minLength: 3,
  payRate: 1.5,
  haulRate: 1.0,
  accel: 1.0,
  tensionWarn: 2500,
  tensionLimit: 4500,
  slipTension: 7000,
  slackWarn: 30,
  autoSlack: 6,
  autoSlackFraction: 0.12,
  drumCoreRadius: 0.32,
  drumFullRadius: 0.62,
};

export class TmsWinch {
  readonly config: TmsConfig;
  mode: TmsMode = 'auto';
  command: TmsCommand = 'stop';
  payout: number;
  /** Signed line speed (m/s): + paying out. */
  speed = 0;
  drumAngle = 0;
  state: TmsState = 'stop';
  /** Seconds the drive has been working against the limits (for evaluation). */
  overloadTime = 0;

  constructor(config: Partial<TmsConfig> = {}, initialPayout = 30) {
    this.config = { ...DEFAULT_TMS, ...config };
    this.payout = this.clampLen(initialPayout);
  }

  private clampLen(v: number): number {
    return Math.min(this.config.maxLength, Math.max(this.config.minLength, v));
  }

  reset(payout: number, mode: TmsMode = this.mode): void {
    this.payout = this.clampLen(payout);
    this.speed = 0;
    this.command = 'stop';
    this.mode = mode;
    this.state = mode === 'auto' ? 'auto' : 'stop';
    this.overloadTime = 0;
  }

  /** Fraction of the capacity stored on the drum (0..1). */
  get storedFraction(): number {
    return 1 - this.payout / this.config.maxLength;
  }

  get stored(): number {
    return this.config.maxLength - this.payout;
  }

  /** Current effective drum radius (cable layers). */
  get drumRadius(): number {
    const c = this.config;
    return c.drumCoreRadius + (c.drumFullRadius - c.drumCoreRadius) * this.storedFraction;
  }

  /**
   * @param chord straight distance TMS → ROV (m)
   * @param tension tension at the ROV termination (N)
   */
  update(dt: number, chord: number, tension: number): void {
    const c = this.config;
    let target = 0;
    let state: TmsState;
    if (this.mode === 'auto') {
      const want = chord * (1 + c.autoSlackFraction) + c.autoSlack;
      target = Math.max(-c.haulRate, Math.min(c.payRate, (want - this.payout) * 0.5));
      if (Math.abs(target) < 0.02) target = 0;
      state = 'auto';
    } else {
      target = this.command === 'pay' ? c.payRate : this.command === 'haul' ? -c.haulRate : 0;
      state = this.command;
    }
    // Protections.
    if (target < 0 && tension > c.tensionLimit) {
      target = 0;
      state = 'tensionTrip';
    }
    // Ramp the drive.
    const dv = c.accel * dt;
    this.speed += Math.max(-dv, Math.min(dv, target - this.speed));
    // Brake slip under severe overload (cable rendered out rather than parted).
    let slip = 0;
    if (tension > c.slipTension && this.payout < c.maxLength) {
      slip = Math.min(0.5, ((tension - c.slipTension) / c.slipTension) * 0.8);
      state = 'slip';
    }
    if (tension > c.tensionLimit) this.overloadTime += dt;
    const before = this.payout;
    this.payout = this.clampLen(this.payout + (this.speed + slip) * dt);
    if (this.payout >= c.maxLength && this.speed > 0) {
      this.speed = 0;
      state = 'limitMax';
    } else if (this.payout <= c.minLength && this.speed < 0) {
      this.speed = 0;
      state = 'limitMin';
    }
    const moved = this.payout - before;
    this.drumAngle += moved / this.drumRadius;
    this.state = state;
  }

  /** Pilot command (manual mode). Simultaneous pay+haul resolves to stop. */
  setCommand(pay: boolean, haul: boolean): void {
    this.command = pay && !haul ? 'pay' : haul && !pay ? 'haul' : 'stop';
  }
}
