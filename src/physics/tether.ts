import { Vector3 } from 'three';

/**
 * Umbilical / tether — quasi-static, low-cost model (v2.0).
 *
 * This is deliberately NOT a lumped-mass cable (no hundreds of segments).
 * Each physics step:
 *  1. Winch: the paid-out length L follows a target slightly longer than the
 *     straight anchor→ROV distance d (L* = d·slackFactor + slackExtra),
 *     limited by payout / haul-in rates and by `maxLength`.
 *  2. Shape: a parabolic bow in the plane of the mean distributed load
 *     (normal drag + wet weight). Its amplitude comes from the slack:
 *     arc length ≈ d + 8a²/(3d)  ⇒  a = √(3·d·(L − d)/8).
 *  3. Distributed load: Morison-type normal drag ½ρ·Cd·D·|uₙ|uₙ (+ a small
 *     tangential skin-friction term) at `segments` points along that shape,
 *     using the current profile and an approximate cable velocity (linear
 *     from the fixed anchor, 0, to the ROV end, v). Each element's load is
 *     shared between the two ends like a string pinned at both ends: the ROV
 *     takes the fraction s (s = 0 at the anchor, 1 at the ROV). The drag of
 *     the cable moving with the ROV provides the "gentle damping".
 *  4. Winch limit: when d > L the cable is taut and a stiff spring + damper
 *     along the chord pulls the ROV back towards the anchor (cable stretch +
 *     winch brake), tension-only.
 *  5. Robustness: total force magnitude clamped to `maxForce`; a jump of the
 *     attach point larger than `teleportDistance` in one step re-initialises
 *     the winch state instead of producing a huge spring force.
 * Approximations: no cable inertia, no wave propagation, no snap loads, no
 * contact with the seabed (only the rendered polyline is clamped above it),
 * load sharing by a fixed linear rule. Numbers are plausible for a ~30 mm
 * near-neutral work-class umbilical, not data of a real product.
 */

export interface TetherConfig {
  /** Total cable on the winch drum (m). */
  maxLength: number;
  /** Paid-out length never goes below this (m). */
  minLength: number;
  /** Outer diameter (m). */
  diameter: number;
  /** Normal drag coefficient of the cylinder. */
  normalDrag: number;
  /** Tangential (skin friction) coefficient, applied on π·D. */
  tangentialDrag: number;
  /** Submerged weight per metre (N/m, + = sinks). Near-neutral umbilical. */
  wetWeight: number;
  /** Max winch payout speed (m/s). */
  payoutRate: number;
  /** Max winch haul-in speed (m/s). */
  haulRate: number;
  /** Auto-payout keeps L ≈ d·slackFactor + slackExtra. */
  slackFactor: number;
  slackExtra: number;
  /** Axial stiffness when taut (N/m) — cable stretch + winch brake, softened for stability. */
  stiffness: number;
  /** Axial damping when taut (N·s/m). */
  damping: number;
  /** Clamp of the total force on the ROV (N). */
  maxForce: number;
  /** Integration points for the distributed load. */
  segments: number;
  /** Attach-point jump (m) in one step treated as a teleport. */
  teleportDistance: number;
  waterDensity: number;
}

export const DEFAULT_TETHER: TetherConfig = {
  maxLength: 600,
  minLength: 10,
  diameter: 0.03,
  normalDrag: 1.2,
  tangentialDrag: 0.01,
  wetWeight: 0.5, // ≈ 0.05 kg/m in water: near-neutral
  payoutRate: 1.5,
  haulRate: 0.8,
  slackFactor: 1.08,
  slackExtra: 6,
  stiffness: 20000,
  damping: 7000,
  maxForce: 9000,
  segments: 8,
  teleportDistance: 6,
  waterDensity: 1025,
};

/** Anything that can push on the ROV at its tether termination (see RovPhysics). */
export interface TetherForceProvider {
  /**
   * Advance one physics step and return the force on the ROV (world frame, N)
   * acting at the attach point.
   */
  step(dt: number, attachWorld: Vector3, attachVelocityWorld: Vector3, out: Vector3): Vector3;
}

export type CurrentField = (position: Vector3, out: Vector3) => Vector3;

const _chord = new Vector3();
const _u = new Vector3();
const _p = new Vector3();
const _t = new Vector3();
const _w = new Vector3();
const _rel = new Vector3();
const _f = new Vector3();
const _load = new Vector3();

export class Tether implements TetherForceProvider {
  readonly config: TetherConfig;
  /** Fixed end (vessel launch point / TMS), world (m). */
  readonly anchor = new Vector3();
  /** ROV end, world (m), from the last step. */
  readonly attach = new Vector3();
  /** Paid-out length (m). */
  payout = 0;
  /** When true the winch tracks the ROV automatically; otherwise `payout` is left to the caller. */
  autoPayout = true;
  /** When false `step` returns zero force (e.g. while the ROV hangs on the crane). */
  enabled = true;
  /** Last total force on the ROV (world, N). */
  readonly force = new Vector3();
  /** Part of `force` due to the distributed drag + weight (world, N). */
  readonly dragForce = new Vector3();
  /** Axial tension from the taut spring (N), 0 when slack. */
  tension = 0;
  /** Bow amplitude (m) and its unit direction (world). */
  sag = 0;
  readonly sagDirection = new Vector3(0, -1, 0);
  /** Optional seabed height for clamping the rendered polyline. */
  terrainHeight?: (x: number, z: number) => number;
  private initialised = false;

  constructor(
    private readonly current: CurrentField,
    config: Partial<TetherConfig> = {},
    terrainHeight?: (x: number, z: number) => number,
  ) {
    this.config = { ...DEFAULT_TETHER, ...config };
    this.terrainHeight = terrainHeight;
  }

  /** Straight-line anchor → ROV distance (m). */
  get chordLength(): number {
    return this.anchor.distanceTo(this.attach);
  }

  /** True when the cable is stretched beyond the paid-out length. */
  get taut(): boolean {
    return this.chordLength > this.payout;
  }

  /** True when the drum is empty (payout at `maxLength`). */
  get atMaxLength(): boolean {
    return this.payout >= this.config.maxLength - 1e-6;
  }

  /** Re-initialise the winch for a new anchor / ROV position (no transient). */
  reset(anchor: Vector3, attach: Vector3): void {
    this.anchor.copy(anchor);
    this.attach.copy(attach);
    this.payout = this.targetPayout(this.chordLength);
    this.force.set(0, 0, 0);
    this.dragForce.set(0, 0, 0);
    this.tension = 0;
    this.sag = 0;
    this.initialised = true;
  }

  private targetPayout(d: number): number {
    const c = this.config;
    return Math.min(c.maxLength, Math.max(c.minLength, d * c.slackFactor + c.slackExtra));
  }

  step(dt: number, attachWorld: Vector3, attachVelocityWorld: Vector3, out: Vector3): Vector3 {
    const c = this.config;
    if (!this.initialised || attachWorld.distanceTo(this.attach) > c.teleportDistance || !Number.isFinite(this.payout)) {
      this.reset(this.anchor, attachWorld);
    }
    this.attach.copy(attachWorld);
    if (!this.enabled) {
      // Winch keeps the right slack ready, so enabling never starts taut.
      if (this.autoPayout) this.payout = this.targetPayout(this.chordLength);
      this.force.set(0, 0, 0);
      this.dragForce.set(0, 0, 0);
      this.tension = 0;
      return out.set(0, 0, 0);
    }

    const chord = _chord.subVectors(this.attach, this.anchor);
    const d = chord.length();
    const u = d > 1e-6 ? _u.copy(chord).divideScalar(d) : _u.set(0, -1, 0);

    // 1. Winch.
    if (this.autoPayout) {
      const target = d > this.payout ? c.maxLength : this.targetPayout(d);
      const delta = target - this.payout;
      this.payout += delta > 0 ? Math.min(delta, c.payoutRate * dt) : Math.max(delta, -c.haulRate * dt);
    }
    this.payout = Math.min(c.maxLength, Math.max(c.minLength, this.payout));
    const L = Math.max(this.payout, 1e-3);

    // 2. Shape (bow amplitude from the slack, direction from last step's load).
    const slack = Math.max(0, L - d);
    this.sag = Math.min(0.5 * L, Math.sqrt((3 * d * slack) / 8));
    const sagDir = this.sagDirection;

    // 3. Distributed load, shared with the ROV end by the fraction s.
    const n = c.segments;
    const ds = L / n;
    const kN = 0.5 * c.waterDensity * c.normalDrag * c.diameter;
    const kT = 0.5 * c.waterDensity * c.tangentialDrag * Math.PI * c.diameter;
    const drag = this.dragForce.set(0, 0, 0);
    _load.set(0, 0, 0);
    for (let k = 0; k < n; k++) {
      const s = (k + 0.5) / n;
      const bow = 4 * this.sag * s * (1 - s);
      _p.copy(this.anchor).addScaledVector(chord, s).addScaledVector(sagDir, bow);
      // Local tangent of the parabola.
      _t.copy(chord).addScaledVector(sagDir, 4 * this.sag * (1 - 2 * s));
      const tl = _t.length();
      if (tl > 1e-9) _t.divideScalar(tl);
      else _t.copy(u);
      this.current(_p, _w);
      // Water velocity relative to the cable element (cable moves ~ s·v_ROV).
      _rel.copy(_w).addScaledVector(attachVelocityWorld, -s);
      const ut = _rel.dot(_t);
      _rel.addScaledVector(_t, -ut); // normal component
      const un = _rel.length();
      _f.copy(_rel).multiplyScalar(kN * un * ds);
      _f.addScaledVector(_t, kT * Math.abs(ut) * ut * ds);
      _f.y -= c.wetWeight * ds;
      _load.addScaledVector(_f, s * (1 - s));
      drag.addScaledVector(_f, s);
    }
    // Sag direction for the next step: mean load normal to the chord.
    _load.addScaledVector(u, -_load.dot(u));
    const ll = _load.length();
    if (ll > 1e-6) {
      _load.divideScalar(ll);
      // Low-pass to avoid flicker of the rendered shape.
      sagDir.lerp(_load, 1 - Math.exp(-dt / 0.5));
      const sl = sagDir.length();
      if (sl > 1e-6) sagDir.divideScalar(sl);
      else sagDir.copy(_load);
    }

    // 4. Taut cable: spring + damper along the chord, tension only.
    let T = 0;
    if (d > L) {
      const vr = attachVelocityWorld.dot(u);
      T = c.stiffness * (d - L) + c.damping * vr;
      if (T < 0) T = 0;
    }
    this.tension = Math.min(T, c.maxForce);

    out.copy(drag).addScaledVector(u, -this.tension);
    const m = out.length();
    if (!(m <= c.maxForce)) {
      if (Number.isFinite(m)) out.multiplyScalar(c.maxForce / m);
      else out.set(0, 0, 0);
    }
    this.force.copy(out);
    return out;
  }

  /**
   * Points along the cable for rendering, anchor first, ROV last (world).
   * At most 24 points. `out` is reused/resized when given.
   */
  polyline(points = 16, out: Vector3[] = []): Vector3[] {
    const n = Math.max(2, Math.min(24, Math.floor(points)));
    out.length = n;
    const chord = _chord.subVectors(this.attach, this.anchor);
    for (let k = 0; k < n; k++) {
      const s = k / (n - 1);
      const p = out[k] ?? (out[k] = new Vector3());
      p.copy(this.anchor).addScaledVector(chord, s).addScaledVector(this.sagDirection, 4 * this.sag * s * (1 - s));
      if (k > 0 && k < n - 1) {
        // Stay below the free surface and above the seabed.
        const chordY = this.anchor.y + chord.y * s;
        if (p.y > Math.max(0, chordY)) p.y = Math.max(0, chordY);
        if (this.terrainHeight) {
          const floor = this.terrainHeight(p.x, p.z) + 0.15;
          if (p.y < floor) p.y = floor;
        }
      }
    }
    return out;
  }
}
