/**
 * Sediment resuspension model: a small pool of Gaussian "puffs" of suspended
 * sediment stirred up by the vehicle (thruster wash, skid contact) near the
 * seabed. Pure TypeScript (math only), deterministic for a given sequence of
 * inputs — the same model feeds every camera panel, every window and, in the
 * future, optical sensors.
 *
 * Units: a puff carries an "optical mass" M = ∫ c_s dV (m²), the volume
 * integral of the beam extinction it adds to the water. Its extinction field
 * is c_s(r) = M / (π^{3/2} σ³) · exp(−r²/σ²), so `densityAt` returns extra
 * beam extinction (1/m) directly and line-of-sight optical depths are
 * analytic (error function).
 *
 * Physics (simplified, tuned for plausibility — see docs/PESQUISA_TECNICA):
 *  - source: erosion rate ∝ disturbance × erodibility(sedimentAt) above a small
 *    threshold, faded out with the height of the vehicle above the seabed;
 *  - each puff is carried by the local current (bottom boundary layer from the
 *    environment), first lifted by the jet (decaying), then settles with a
 *    velocity derived from the sediment's settleTime;
 *  - it grows by jet entrainment (early) and turbulent diffusion (K grows with
 *    the current speed); mass is lost by deposition with time scale settleTime;
 *  - a hard budget bounds the total mass, the number of puffs and the peak
 *    density; overlapping old puffs merge (moment-preserving).
 */
import { Vector3 } from 'three';
import { sedimentAt, sedimentProps, type SedimentMix } from './sediment';
import { getTerrainSeed, terrainHeight } from './terrain';

/** Water velocity at a point (m/s, world frame), e.g. `Simulation.env.current`. */
export type CurrentSampler = (p: Vector3, out: Vector3) => Vector3;

export interface SedimentSource {
  /** Disturbance 0..1 (RovPhysics.seabedDisturbance). */
  amount: number;
  /** Vehicle (or disturbance) position; the puff is born on the seabed below it. */
  x: number;
  y: number;
  z: number;
}

export interface SedimentPuff {
  /** Centre (m, world). */
  x: number;
  y: number;
  z: number;
  /** Gaussian radius σ (m): extinction ∝ exp(−r²/σ²). */
  sigma: number;
  /** Optical mass ∫c dV (m²). */
  mass: number;
  /** Age (s). */
  age: number;
  /** Settling / deposition time scale of this sediment (s). */
  settleTime: number;
  /** Jet-driven vertical velocity (m/s), decays. */
  rise: number;
  /** Horizontal wall-jet velocity (m/s, radial from the impingement point), decays. */
  ux: number;
  uz: number;
  /** Jet entrainment growth rate (m/s), decays. */
  growth: number;
  /** Fractions of the sediment type (for colour). */
  mud: number;
  sand: number;
  /** Stable identifier (emission counter). */
  id: number;
}

/** Compact render view of a puff. */
export interface PuffView {
  x: number;
  y: number;
  z: number;
  sigma: number;
  /** Peak extra extinction at the centre (1/m). */
  density: number;
  /** Age (s) and sediment fractions (for the particle shader / colour). */
  age: number;
  mud: number;
  sand: number;
  id: number;
}

export interface SedimentCloudOptions {
  /** Maximum number of puffs (default 24). */
  maxPuffs?: number;
  /** Seed of the sediment field (`sedimentAt`; default: the active terrain seed). */
  seed?: number;
  /** Seabed height (default: the site terrain). */
  ground?: (x: number, z: number) => number;
  /** Sediment mix of the bed (default: `sedimentAt(x, z, seed)`). */
  mix?: (x: number, z: number) => SedimentMix;
}

const PI15 = Math.pow(Math.PI, 1.5);
const SQRT_PI_2 = Math.sqrt(Math.PI) / 2;
/** Optical mass eroded per second at disturbance 1 over pure mud (m²/s). */
const EMIT_RATE = 16;
/** Forcing threshold (disturbance × erodibility) below which nothing lifts. */
const EMIT_THRESHOLD = 0.025;
/** Total optical mass budget (m²). ~ a 2 m-radius cloud of 4/m peak. */
const MASS_BUDGET = 160;
/** Optical mass of one puff before a new one is started (m²). */
const PUFF_MAX_MASS = 14;
/** A new puff is started at least this often while emitting (s). */
const SPAWN_INTERVAL = 0.45;
/** Puffs are dropped below this mass (m²). */
const MIN_MASS = 0.03;
/** Typical lift of a cloud (m): settling velocity = SETTLE_HEIGHT / settleTime. */
const SETTLE_HEIGHT = 1.4;
const SIGMA0 = 0.35;
const SIGMA_MAX = 7;
/** Background turbulent diffusivity and its growth with the current speed (m²/s, s·m). */
const K0 = 0.012;
const K_CURRENT = 0.12;
/** Height above the seabed (m) at which emission is fully faded out (6 → 8 m). */
const FADE_FULL = 6;
const FADE_ZERO = 8;

/** Error function (Abramowitz–Stegun 7.1.26, |ε| < 1.5e-7). */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** Deterministic hash → [0,1). */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class SedimentCloud {
  /** Resuspension strength (settings, 0..2; 0 = off). */
  strength = 1;
  readonly maxPuffs: number;
  private readonly list: SedimentPuff[] = [];
  private readonly ground: (x: number, z: number) => number;
  private readonly mixAt: (x: number, z: number) => SedimentMix;
  private emitted = 0;
  private sinceSpawn = 1e9;
  private readonly vTmp = new Vector3();
  private readonly cTmp = new Vector3();

  constructor(opts: SedimentCloudOptions = {}) {
    this.maxPuffs = Math.max(2, Math.min(64, opts.maxPuffs ?? 24));
    this.ground = opts.ground ?? ((x, z) => terrainHeight(x, z));
    const seed = opts.seed;
    this.mixAt = opts.mix ?? ((x, z) => sedimentAt(x, z, seed ?? getTerrainSeed()));
  }

  get puffs(): readonly SedimentPuff[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  get totalMass(): number {
    let m = 0;
    for (const p of this.list) m += p.mass;
    return m;
  }

  reset(): void {
    this.list.length = 0;
    this.sinceSpawn = 1e9;
  }

  /** Erosion forcing (0..1+) the source would produce at its position (0 when off / too high). */
  forcing(source: SedimentSource | null): number {
    if (!source || this.strength <= 0) return 0;
    const amount = Number.isFinite(source.amount) ? Math.min(1, Math.max(0, source.amount)) : 0;
    if (amount <= 0) return 0;
    const g = this.ground(source.x, source.z);
    const h = source.y - g;
    const fade = Math.min(1, Math.max(0, (FADE_ZERO - h) / (FADE_ZERO - FADE_FULL)));
    if (fade <= 0) return 0;
    const props = sedimentProps(this.mixAt(source.x, source.z));
    return amount * fade * props.erodibility * this.strength;
  }

  /**
   * Advance the cloud by dt (s): emission from `source`, transport by
   * `current` (zero when omitted), growth, settling, deposition, merging.
   */
  step(dt: number, source: SedimentSource | null, current?: CurrentSampler | null): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.5);
    this.emit(dt, source);
    const v = this.vTmp;
    for (const p of this.list) {
      if (current) current(this.cTmp.set(p.x, p.y, p.z), v);
      else v.set(0, 0, 0);
      const speed = Math.hypot(v.x, v.z);
      // Vertical: jet lift (decaying) then settling once the jet has died out.
      const k = Math.exp(-dt / 1.3);
      p.rise *= k;
      p.ux *= k;
      p.uz *= k;
      const ws = SETTLE_HEIGHT / Math.max(1, p.settleTime);
      const vy = p.rise - ws * Math.min(1, p.age / 2.5) + v.y;
      p.x += (v.x + p.ux) * dt;
      p.z += (v.z + p.uz) * dt;
      p.y += vy * dt;
      const g = this.ground(p.x, p.z);
      const floor = g + 0.3 * p.sigma;
      let onBed = 0;
      if (p.y < floor) {
        p.y = floor;
        onBed = 1;
      }
      // Growth: entrainment (early, jet-driven) + turbulent diffusion; a cloud
      // resting on the bed spreads laterally a little faster (density current).
      const K = K0 + K_CURRENT * speed * (1 + 0.5 * onBed);
      p.sigma = Math.min(SIGMA_MAX, p.sigma + (p.growth * Math.exp(-p.age / 1.5) + (2 * K) / p.sigma) * dt);
      // Deposition: faster once the settled cloud lies on the bed.
      p.mass *= Math.exp(-(dt / p.settleTime) * (1 + 0.6 * onBed));
      p.age += dt;
    }
    this.mergeOverlapping();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.mass < MIN_MASS || this.peak(p) < 2e-3) this.list.splice(i, 1);
    }
  }

  private emit(dt: number, source: SedimentSource | null): void {
    this.sinceSpawn += dt;
    const f = this.forcing(source);
    if (!source || f <= EMIT_THRESHOLD) return;
    const total = this.totalMass;
    const room = Math.max(0, 1 - total / MASS_BUDGET);
    let dm = EMIT_RATE * (f - EMIT_THRESHOLD) * dt * room;
    if (dm <= 0) return;
    const amount = Math.min(1, Math.max(0, source.amount));
    const mix = this.mixAt(source.x, source.z);
    const props = sedimentProps(mix);
    const g = this.ground(source.x, source.z);
    const young = this.list.length ? this.list[this.list.length - 1] : null;
    const near =
      young && young.age < SPAWN_INTERVAL * 2 && Math.hypot(young.x - source.x, young.z - source.z) < 0.8 && this.sinceSpawn < SPAWN_INTERVAL;
    if (near && young && young.mass < PUFF_MAX_MASS) {
      // Feed the puff being formed (mass-weighted centre).
      const add = Math.min(dm, PUFF_MAX_MASS - young.mass);
      const m = young.mass + add;
      young.x = (young.x * young.mass + source.x * add) / m;
      young.z = (young.z * young.mass + source.z * add) / m;
      young.mass = m;
      young.rise = Math.max(young.rise, 0.45 * amount);
      dm -= add;
      if (dm <= 1e-6) return;
    }
    if (this.list.length >= this.maxPuffs) this.mergeClosestPair();
    const n = ++this.emitted;
    // A jet impinging on the bed spreads radially (wall jet): puffs are born
    // around the impingement point and pushed outwards, lifted by the jet.
    const a = hash01(n) * Math.PI * 2;
    const r = 0.5 * Math.sqrt(hash01(n + 0.37));
    const out = 0.35 * amount * (0.5 + hash01(n + 0.53));
    this.list.push({
      x: source.x + Math.cos(a) * r,
      y: g + 0.25,
      z: source.z + Math.sin(a) * r,
      sigma: SIGMA0 + 0.25 * amount,
      mass: Math.min(PUFF_MAX_MASS, dm),
      age: 0,
      settleTime: Math.max(1, props.settleTime),
      rise: 0.45 * amount * (0.7 + 0.6 * hash01(n + 0.71)),
      ux: Math.cos(a) * out,
      uz: Math.sin(a) * out,
      growth: 0.5 * (0.4 + amount),
      mud: mix.mud,
      sand: mix.sand,
      id: n,
    });
    this.sinceSpawn = 0;
  }

  private peak(p: SedimentPuff): number {
    return p.mass / (PI15 * p.sigma * p.sigma * p.sigma);
  }

  private static merge(a: SedimentPuff, b: SedimentPuff): void {
    const m = a.mass + b.mass;
    const wa = a.mass / m;
    const wb = b.mass / m;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    // Preserve the second moment: σ² = Σw σ² + wa wb |Δ|² (per-axis variance σ²/2 → factor 2/3 for the 3-D spread).
    const s2 = wa * a.sigma * a.sigma + wb * b.sigma * b.sigma + ((2 / 3) * wa * wb * (dx * dx + dy * dy + dz * dz));
    a.x = a.x * wa + b.x * wb;
    a.y = a.y * wa + b.y * wb;
    a.z = a.z * wa + b.z * wb;
    a.sigma = Math.min(SIGMA_MAX, Math.sqrt(s2));
    a.settleTime = a.settleTime * wa + b.settleTime * wb;
    a.rise = a.rise * wa + b.rise * wb;
    a.ux = a.ux * wa + b.ux * wb;
    a.uz = a.uz * wa + b.uz * wb;
    a.growth = a.growth * wa + b.growth * wb;
    a.mud = a.mud * wa + b.mud * wb;
    a.sand = a.sand * wa + b.sand * wb;
    a.age = Math.max(a.age, b.age);
    a.mass = m;
  }

  /** Old puffs that overlap strongly have become one cloud: merge them. */
  private mergeOverlapping(): void {
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.age < 1.5) continue;
      for (let j = L.length - 1; j > i; j--) {
        const b = L[j];
        if (b.age < 1.5) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d < 0.2 * (a.sigma + b.sigma)) {
          SedimentCloud.merge(a, b);
          L.splice(j, 1);
        }
      }
    }
  }

  /** Pool full: merge the two puffs that are closest relative to their size. */
  private mergeClosestPair(): void {
    const L = this.list;
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = L[i];
        const b = L[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / (a.sigma + b.sigma);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    SedimentCloud.merge(L[bi], L[bj]);
    L.splice(bj, 1);
  }

  /** Extra beam extinction (1/m) at a point. */
  densityAt(p: { x: number; y: number; z: number }): number {
    let s = 0;
    for (const q of this.list) {
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const dz = p.z - q.z;
      s += this.peak(q) * Math.exp(-(dx * dx + dy * dy + dz * dz) / (q.sigma * q.sigma));
    }
    return s;
  }

  /** Optical depth ∫c_s dl of the cloud along the segment from → to. */
  opticalDepth(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): number {
    const lx = to.x - from.x;
    const ly = to.y - from.y;
    const lz = to.z - from.z;
    const len = Math.hypot(lx, ly, lz);
    if (len < 1e-6) return 0;
    const ux = lx / len;
    const uy = ly / len;
    const uz = lz / len;
    let tau = 0;
    for (const q of this.list) {
      const ox = q.x - from.x;
      const oy = q.y - from.y;
      const oz = q.z - from.z;
      const tc = ox * ux + oy * uy + oz * uz;
      const d2 = Math.max(0, ox * ox + oy * oy + oz * oz - tc * tc);
      const s = q.sigma;
      tau += this.peak(q) * Math.exp(-d2 / (s * s)) * s * SQRT_PI_2 * (erf((len - tc) / s) - erf(-tc / s));
    }
    return tau;
  }

  /** Fraction of light lost along the line of sight to the cloud (0 = clear, →1 = opaque). */
  lineOfSightOpacity(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): number {
    return 1 - Math.exp(-this.opticalDepth(from, to));
  }

  /**
   * The K puffs that matter most for a viewer at `eye` (in a water of beam
   * extinction `waterExt`, 1/m): ranked by their column optical depth seen
   * through the water. The remaining puffs are folded (mass- and
   * moment-preserving) into the nearest selected one, so the rendered cloud
   * keeps its total opacity and does not pop when the selection changes.
   */
  relevant(k: number, eye: { x: number; y: number; z: number }, waterExt = 0.25, out: PuffView[] = []): PuffView[] {
    out.length = 0;
    const L = this.list;
    if (!L.length || k <= 0) return out;
    const scored = L.map((p) => {
      const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
      const col = p.mass / (Math.PI * p.sigma * p.sigma);
      return { p, score: col * Math.exp(-waterExt * Math.max(0, d - p.sigma)) };
    });
    scored.sort((a, b) => b.score - a.score || a.p.id - b.p.id);
    const chosen = scored.slice(0, k).map((s) => ({ ...s.p }));
    for (const s of scored.slice(k)) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i];
        const d = Math.hypot(c.x - s.p.x, c.y - s.p.y, c.z - s.p.z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      SedimentCloud.merge(chosen[best], { ...s.p });
    }
    for (const c of chosen) out.push(SedimentCloud.view(c));
    return out;
  }

  /** Every puff as a render view (for particle sprites), at most `max`. */
  allViews(max: number, out: PuffView[] = []): PuffView[] {
    out.length = 0;
    const n = Math.min(max, this.list.length);
    for (let i = 0; i < n; i++) out.push(SedimentCloud.view(this.list[i]));
    return out;
  }

  private static view(c: SedimentPuff): PuffView {
    return { x: c.x, y: c.y, z: c.z, sigma: c.sigma, density: c.mass / (PI15 * c.sigma * c.sigma * c.sigma), age: c.age, mud: c.mud, sand: c.sand, id: c.id };
  }
}
