import { Vector3 } from 'three';
import type { BoxCollider, CapsuleCollider, Collider } from '../sim/site';
import { colliderBounds } from '../physics/collision';

/**
 * Forward-looking imaging sonar (FLS), geometry-driven. See docs/SONAR.md.
 *
 * Sensor: a 130° horizontal fan of `beams` beams, each `HALF_BEAM_V`·2 = 20°
 * tall in elevation, depressed by `tilt` below the vehicle's horizontal; the
 * echo of each beam is sampled into `bins` range bins of `range / bins` metres.
 * Bin i covers slant ranges [i·step, (i+1)·step).
 *
 * Every echo comes from real scene geometry:
 *  - Structures (colliders): EL_RAYS sub-rays sweep the vertical beam; each is
 *    ray-cast analytically (box slabs, capsule) and only its FIRST hit echoes,
 *    so nearer objects hide farther ones. Each sub-ray is a thin cone (half
 *    angle = half the beam spacing) so objects thinner than the ray spacing
 *    are still detected, at the range of their true surface.
 *  - Seabed (height field): for each range bin, the elevation at which the
 *    range sphere meets the bottom is found inside the vertical beam; the echo
 *    depends on the grazing angle. It is hidden (acoustic shadow) when the line
 *    of sight to it crosses a structure or a nearer terrain crest.
 * Intensity = target reflectivity × incidence term × vertical beam pattern ×
 * transmission loss. Ping data is deterministic and noise-free; the speckle /
 * noise floor is added only on the display and is bounded below
 * SONAR_DETECT_LEVEL. Not modelled: multipath, refraction, side lobes,
 * surface reverberation, Doppler.
 *
 * The ping is computed incrementally (scan(..., count) beams per frame); the
 * last COMPLETE ping is displayed (double buffer, no tearing).
 */

export type SonarQuality = 'low' | 'medium' | 'high';
export const SONAR_RANGES = [10, 20, 40, 60] as const;
/** Horizontal field of view (deg). */
export const SONAR_FOV = 130;
const QUALITY: Record<SonarQuality, { beams: number; bins: number }> = {
  low: { beams: 48, bins: 80 },
  medium: { beams: 96, bins: 128 },
  high: { beams: 128, bins: 192 },
};

const DEG = Math.PI / 180;
/** Vertical half-beamwidth (deg). */
export const SONAR_HALF_BEAM_V = 10;
const HALF_BEAM_V = SONAR_HALF_BEAM_V;
const PING_FRAMES = 14; // a full ping completes in ≈ 14 frames (≈ 0.23 s at 60 fps)
const SEABED_ITERS = 1; // regula-falsi refinements per range bin for the seabed crossing
const SEABED_MARGIN = 2; // deg sampled beyond the beam edges (for occlusion only)
const EL_RAYS = 21; // structure sub-rays across the vertical beam (1° apart)
const EL_SPACING = (2 * HALF_BEAM_V) / (EL_RAYS - 1);
/** Structure (steel) reflectivity relative to the brightest seabed. */
const TS_STRUCT = 1;
const HORIZON_TOL = 0.3 * DEG;

/** Display level (0..1) at or above which a pixel reads as a target. */
export const SONAR_DETECT_LEVEL = 0.2;

export interface SonarPing {
  /** beams × bins echo levels, beam-major (beam b, bin i → data[b·bins + i]). */
  data: Float32Array;
  beams: number;
  bins: number;
  range: number;
  heading: number;
  tilt: number;
}
type Ping = SonarPing;

/** Relative bearing (deg, + = starboard) of the centre of beam `b`. */
export function beamBearing(b: number, beams: number, fov = SONAR_FOV): number {
  return -fov / 2 + (b + 0.5) * (fov / beams);
}

/** Two-way vertical beam pattern (power), δ = elevation off the beam axis (deg). */
function beamPattern(delta: number): number {
  if (Math.abs(delta) > HALF_BEAM_V) return 0;
  const c = Math.cos((delta / HALF_BEAM_V) * Math.PI * 0.5);
  return 0.35 + 0.65 * c * c;
}

/** Spreading + absorption loss, partly compensated on board (display TVG does the rest). */
function transmissionLoss(r: number): number {
  return 0.6 + 0.4 / (1 + 0.02 * r);
}

/**
 * Display transfer function: echo level → 0..1 display level, with time-varied
 * gain, operator gain, multiplicative speckle and a fixed additive noise floor.
 * `speckle` is a uniform random in [0, 1]. With echo = 0 the result is always
 * below SONAR_DETECT_LEVEL (noise never forms a target).
 */
export function sonarDisplayLevel(echo: number, rangeFrac: number, gain: number, speckle: number): number {
  const tvg = 1 + 2.2 * rangeFrac;
  const v0 = echo * tvg * gain * (0.8 + 0.4 * speckle) + 0.02 + 0.03 * speckle * (0.4 + rangeFrac);
  return 1 - Math.exp(-1.7 * v0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Blue FLS palette on black (256 entries, RGB): black → navy → blue → cyan → white.
const PALETTE = (() => {
  const stops: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [0.18, 3, 14, 44],
    [0.42, 16, 64, 160],
    [0.68, 52, 150, 236],
    [0.86, 150, 218, 255],
    [1, 240, 250, 255],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k];
    const b = stops[k + 1];
    const u = (t - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u;
  }
  return lut;
})();

const SPECKLE_N = 128;
const SPECKLE = (() => {
  const rnd = mulberry32(0x50a4);
  const t = new Float32Array(SPECKLE_N * SPECKLE_N);
  for (let i = 0; i < t.length; i++) t[i] = rnd();
  return t;
})();

/** Fan layout in CSS px, shared by the image and the overlays. */
export function sonarLayout(w: number, h: number, fov = SONAR_FOV): { font: number; header: number; ox: number; oy: number; R: number } {
  const font = Math.max(9, Math.min(13, Math.round(Math.min(w, h) / 18)));
  const header = font + 8;
  const half = (fov / 2) * DEG;
  const ox = w / 2;
  const oy = h - 4;
  const R = Math.max(10, Math.min(oy - header - font - 8, (w / 2 - 2.2 * font) / Math.sin(half)));
  return { font, header, ox, oy, R };
}

// ---------------------------------------------------------------------------
// Ray casting against colliders. Results go through a shared scratch object.
// ---------------------------------------------------------------------------
interface Hit {
  t: number; // distance along the ray to the reported surface point
  cos: number; // |cos(incidence)| at that point
  fill: number; // 1 = exact hit, <1 = cone near-miss (fraction of the cone filled)
}

const hit: Hit = { t: 0, cos: 0, fill: 0 };

/**
 * Exact ray / yawed box. Returns entry distance (> 0) or -1; sets hit.cos.
 * `grow` inflates the half extents (for cone tests).
 */
function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: BoxCollider, grow: number, maxT: number): number {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const px = ox - b.center.x;
  const pz = oz - b.center.z;
  // world -> local (same convention as collision.ts sphereBox)
  const lo = [px * c - pz * s, oy - b.center.y, px * s + pz * c];
  const ld = [dx * c - dz * s, dy, dx * s + dz * c];
  const hh = [b.half.x + grow, b.half.y + grow, b.half.z + grow];
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-12) {
      if (Math.abs(lo[k]) > hh[k]) return -1;
      continue;
    }
    let t1 = (-hh[k] - lo[k]) / ld[k];
    let t2 = (hh[k] - lo[k]) / ld[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) {
      tmin = t1;
      axis = k;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0 || tmin > maxT) return -1;
  if (tmin <= 0) return grow > 0 ? 0 : -1; // origin inside: ignore exact, near-miss at 0
  hit.cos = Math.abs(ld[axis]);
  return tmin;
}

/** Exact ray / capsule (Íñigo Quílez's formulation). Returns entry distance or -1; sets hit.cos. */
function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cp: CapsuleCollider, maxT: number): number {
  const bax = cp.b.x - cp.a.x;
  const bay = cp.b.y - cp.a.y;
  const baz = cp.b.z - cp.a.z;
  const oax = ox - cp.a.x;
  const oay = oy - cp.a.y;
  const oaz = oz - cp.a.z;
  const ra = cp.radius;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  let t = -1;
  let capCx = 0;
  let capCy = 0;
  let capCz = 0;
  let useCap = true;
  if (a > 1e-9) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - ra * ra * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    const tb = (-b - Math.sqrt(h)) / a;
    const y = baoa + tb * bard;
    if (y > 0 && y < baba) {
      t = tb;
      useCap = false;
      // normal: from the axis point to the hit point
      const k = y / baba;
      const nx = ox + dx * t - (cp.a.x + bax * k);
      const ny = oy + dy * t - (cp.a.y + bay * k);
      const nz = oz + dz * t - (cp.a.z + baz * k);
      hit.cos = Math.abs(nx * dx + ny * dy + nz * dz) / ra;
    } else if (y <= 0) {
      capCx = cp.a.x;
      capCy = cp.a.y;
      capCz = cp.a.z;
    } else {
      capCx = cp.b.x;
      capCy = cp.b.y;
      capCz = cp.b.z;
    }
  } else {
    // ray parallel to the axis: nearest cap
    const ta = (cp.a.x - ox) * dx + (cp.a.y - oy) * dy + (cp.a.z - oz) * dz;
    const tb = (cp.b.x - ox) * dx + (cp.b.y - oy) * dy + (cp.b.z - oz) * dz;
    const pa = ta < tb ? cp.a : cp.b;
    capCx = pa.x;
    capCy = pa.y;
    capCz = pa.z;
  }
  if (useCap) {
    const ocx = ox - capCx;
    const ocy = oy - capCy;
    const ocz = oz - capCz;
    const b = dx * ocx + dy * ocy + dz * ocz;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - ra * ra;
    const h = b * b - c;
    if (h <= 0) return -1;
    t = -b - Math.sqrt(h);
    if (t > 0) {
      const nx = ox + dx * t - capCx;
      const ny = oy + dy * t - capCy;
      const nz = oz + dz * t - capCz;
      hit.cos = Math.abs(nx * dx + ny * dy + nz * dz) / ra;
    }
  }
  if (t <= 0 || t > maxT) return -1;
  return t;
}

/**
 * Cone near-miss against a capsule (ray missed the exact shape): closest
 * approach between the ray segment and the capsule axis within the cone
 * radius tanA·t. Reports the specular point of the capsule facing the sonar.
 */
function coneCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cp: CapsuleCollider, tanA: number, maxT: number): boolean {
  // Closest points between segment P(t) = o + d t, t∈[0,maxT] and Q(s) = a + (b-a) s, s∈[0,1] (Ericson 5.1.9).
  const ex = cp.b.x - cp.a.x;
  const ey = cp.b.y - cp.a.y;
  const ez = cp.b.z - cp.a.z;
  const rx = ox - cp.a.x;
  const ry = oy - cp.a.y;
  const rz = oz - cp.a.z;
  const ee = ex * ex + ey * ey + ez * ez;
  const de = dx * ex + dy * ey + dz * ez;
  const dr = dx * rx + dy * ry + dz * rz;
  const er = ex * rx + ey * ry + ez * rz;
  let t: number;
  let s: number;
  if (ee < 1e-12) {
    s = 0;
    t = Math.max(0, Math.min(maxT, -dr));
  } else {
    const denom = ee - de * de; // |d| = 1
    t = denom > 1e-12 ? Math.max(0, Math.min(maxT, (de * er - dr * ee) / denom)) : 0;
    s = (t * de + er) / ee;
    if (s < 0) {
      s = 0;
      t = Math.max(0, Math.min(maxT, -dr));
    } else if (s > 1) {
      s = 1;
      t = Math.max(0, Math.min(maxT, de - dr));
    }
  }
  const sx = cp.a.x + ex * s;
  const sy = cp.a.y + ey * s;
  const sz = cp.a.z + ez * s;
  const gx = ox + dx * t - sx;
  const gy = oy + dy * t - sy;
  const gz = oz + dz * t - sz;
  const dist = Math.hypot(gx, gy, gz);
  const cone = t * tanA;
  if (dist - cp.radius > cone || cone <= 0) return false;
  // Specular point: axis point + radius towards the sonar, perpendicular to the axis.
  let nx = ox - sx;
  let ny = oy - sy;
  let nz = oz - sz;
  if (ee > 1e-12) {
    const k = (nx * ex + ny * ey + nz * ez) / ee;
    nx -= ex * k;
    ny -= ey * k;
    nz -= ez * k;
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  const qx = sx + (nx / nl) * cp.radius - ox;
  const qy = sy + (ny / nl) * cp.radius - oy;
  const qz = sz + (nz / nl) * cp.radius - oz;
  const r = Math.hypot(qx, qy, qz);
  if (r > maxT || r <= 0) return false;
  hit.t = r;
  hit.cos = Math.abs(qx * nx + qy * ny + qz * nz) / (r * nl);
  hit.fill = Math.max(0, Math.min(1, 1 - (dist - cp.radius) / cone));
  return true;
}

/** Cone near-miss against a box: reports the box surface point closest to the cone axis. */
function coneBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: BoxCollider, grow: number, tanA: number, maxT: number): boolean {
  const tg = rayBox(ox, oy, oz, dx, dy, dz, b, grow, maxT);
  if (tg < 0) return false;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const px = ox + dx * tg - b.center.x;
  const py = oy + dy * tg - b.center.y;
  const pz = oz + dz * tg - b.center.z;
  const lx = px * c - pz * s;
  const lz = px * s + pz * c;
  const qx = Math.max(-b.half.x, Math.min(b.half.x, lx));
  const qy = Math.max(-b.half.y, Math.min(b.half.y, py));
  const qz = Math.max(-b.half.z, Math.min(b.half.z, lz));
  // local -> world
  const wx = b.center.x + qx * c + qz * s - ox;
  const wy = b.center.y + qy - oy;
  const wz = b.center.z - qx * s + qz * c - oz;
  const r = Math.hypot(wx, wy, wz);
  if (r > maxT || r <= 0) return false;
  // Outward normal at q (towards the cone point).
  let nx = lx - qx;
  let ny = py - qy;
  let nz = lz - qz;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-9) return false;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const nwx = nx * c + nz * s;
  const nwz = -nx * s + nz * c;
  hit.t = r;
  hit.cos = Math.abs(nwx * wx + ny * wy + nwz * wz) / r;
  // Distance from q to the cone axis.
  const along = wx * dx + wy * dy + wz * dz;
  const off = Math.hypot(wx - dx * along, wy - dy * along, wz - dz * along);
  const cone = Math.max(1e-6, along * tanA);
  hit.fill = Math.max(0, Math.min(1, 1 - off / cone));
  return hit.fill > 0;
}

export class Sonar {
  range = 40;
  readonly fov = SONAR_FOV;
  /** Vertical beam axis depression below horizontal (deg). */
  tilt = 15;
  /** Display gain multiplier (display only; does not change ping data). */
  gain = 1;
  beams = QUALITY.medium.beams;
  bins = QUALITY.medium.bins;
  quality: SonarQuality = 'medium';
  /** Number of completed pings. */
  pingCount = 0;
  /** Measured ping rate (Hz, smoothed). */
  pingRate = 0;

  private _canvas: HTMLCanvasElement | null = null;
  private front: Ping | null = null;
  private work: Ping;
  private beam = 0;
  private lastDone = 0;
  private readonly origin = new Vector3();
  private readonly bounds: { x: number; y: number; z: number; r: number }[];
  private cand: number[] = []; // ping-level broad-phase
  private beamCand: number[] = []; // beam-level narrow list
  private hitCand: number[] = []; // colliders actually hit in this beam (shadow casters)
  private exactFlag = new Uint8Array(64); // per beam candidate: exact hit on the current sub-ray
  private elTop = new Float32Array(QUALITY.medium.bins);

  // draw caches
  private off: HTMLCanvasElement | null = null;
  private lut: { key: string; bf: Float32Array; rf: Float32Array } | null = null;
  private cacheKey = '';

  constructor(
    private readonly terrainHeight: (x: number, z: number) => number,
    private readonly colliders: readonly Collider[],
  ) {
    this.bounds = colliders.map(colliderBounds);
    this.work = this.newPing();
  }

  /** Lazily created (no DOM needed for scan logic). */
  get canvas(): HTMLCanvasElement {
    if (!this._canvas) {
      if (typeof document === 'undefined') throw new Error('Sonar.canvas requires a DOM');
      this._canvas = document.createElement('canvas');
      this._canvas.className = 'sonar-view';
    }
    return this._canvas;
  }

  setRange(m: number): void {
    const r = SONAR_RANGES.reduce((best, v) => (Math.abs(v - m) < Math.abs(best - m) ? v : best), SONAR_RANGES[0]);
    if (r === this.range) return;
    this.range = r;
    this.restartPing();
  }

  setTilt(deg: number): void {
    this.tilt = Math.max(0, Math.min(45, deg));
    this.restartPing();
  }

  setGain(g: number): void {
    this.gain = Math.max(0.1, Math.min(4, g));
  }

  setQuality(q: SonarQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.beams = QUALITY[q].beams;
    this.bins = QUALITY[q].bins;
    this.work = this.newPing();
    this.restartPing();
  }

  /** Apply operator settings (range, gain, quality, tilt); restarts the ping only on change. */
  configure(c: { range: number; gain: number; quality: SonarQuality; tilt: number }): void {
    this.setRange(c.range);
    this.setGain(c.gain);
    this.setQuality(c.quality);
    if (Math.abs(c.tilt - this.tilt) > 1e-6) this.setTilt(c.tilt);
  }

  /** Last complete ping (read-only view), or null before the first ping finishes. */
  lastPing(): Readonly<Ping> | null {
    return this.front;
  }

  /** Range bin width of the current setting (m). */
  get binSize(): number {
    return this.range / this.bins;
  }

  private newPing(): Ping {
    return {
      data: new Float32Array(this.beams * this.bins),
      beams: this.beams,
      bins: this.bins,
      range: this.range,
      heading: 0,
      tilt: this.tilt,
    };
  }

  private restartPing(): void {
    this.beam = 0;
    if (this.work.beams !== this.beams || this.work.bins !== this.bins) this.work = this.newPing();
  }

  /**
   * Advance the current ping by `count` beams (default: enough for a ≈0.23 s ping at 60 fps;
   * a smaller `count` is raised to that minimum so pings stay fast). Position/heading are
   * latched at the start of each ping.
   */
  /** Sensor ping rate (Hz) — independent of the display frame rate. */
  sensorRate = 5;
  private beamCarry = 0;

  /**
   * Advance the scan by elapsed time `dt` (s) at the sensor's ping rate, so a
   * slow GPU never slows the sonar and a fast one never speeds it up. The work
   * per call is capped (a long stall resumes the ping instead of freezing).
   */
  scanFor(dt: number, pos: Vector3, headingDeg: number): void {
    this.beamCarry += Math.min(0.25, Math.max(0, dt)) * this.sensorRate * this.beams;
    const n = Math.floor(this.beamCarry);
    if (n <= 0) return;
    this.beamCarry -= n;
    this.scanBeams(pos, headingDeg, n);
  }

  private scanBeams(pos: Vector3, headingDeg: number, n: number): void {
    for (let k = 0; k < n; k++) {
      if (this.beam === 0) this.beginPing(pos, headingDeg);
      this.scanBeam(this.beam);
      this.beam++;
      if (this.beam >= this.beams) this.endPing();
    }
  }

  scan(pos: Vector3, headingDeg: number, count?: number): void {
    const minCount = Math.ceil(this.beams / PING_FRAMES);
    const n = Math.max(minCount, count ?? 0);
    for (let k = 0; k < n; k++) {
      if (this.beam === 0) this.beginPing(pos, headingDeg);
      this.scanBeam(this.beam);
      this.beam++;
      if (this.beam >= this.beams) this.endPing();
    }
  }

  /** Cone half-angle of a sub-ray: covers the gap to the neighbouring beam / sub-ray. */
  private coneTan(beams: number): number {
    return Math.tan(Math.max(EL_SPACING / 2, this.fov / beams / 2) * DEG);
  }

  private beginPing(pos: Vector3, headingDeg: number): void {
    const w = this.work;
    w.data.fill(0);
    w.range = this.range;
    w.heading = headingDeg;
    w.tilt = this.tilt;
    if (this.elTop.length < w.bins) this.elTop = new Float32Array(w.bins);
    this.origin.copy(pos);
    // Broad-phase: colliders whose bound intersects the fan's range and angular sector.
    this.cand.length = 0;
    const foot = 0.1 + this.range * this.coneTan(w.beams);
    for (let c = 0; c < this.bounds.length; c++) {
      const b = this.bounds[c];
      const dx = b.x - pos.x;
      const dz = b.z - pos.z;
      const d = Math.hypot(dx, dz);
      const reach = b.r + foot;
      if (d > this.range + reach || Math.abs(b.y - pos.y) > this.range + reach) continue;
      if (d > reach) {
        let off = Math.atan2(dx, -dz) / DEG - headingDeg;
        off = ((((off + 180) % 360) + 360) % 360) - 180;
        if (Math.abs(off) > this.fov / 2 + Math.asin(reach / d) / DEG + 1) continue;
      }
      this.cand.push(c);
    }
  }

  private endPing(): void {
    const done = this.work;
    const old = this.front;
    this.front = done;
    this.work = old && old.beams === this.beams && old.bins === this.bins ? old : this.newPing();
    this.beam = 0;
    this.pingCount++;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.lastDone > 0 && now > this.lastDone) {
      const hz = 1000 / (now - this.lastDone);
      this.pingRate = this.pingRate ? this.pingRate * 0.7 + hz * 0.3 : hz;
    }
    this.lastDone = now;
  }

  private scanBeam(b: number): void {
    const w = this.work;
    const bins = w.bins;
    const step = w.range / bins;
    const maxT = w.range;
    const brg = (w.heading + beamBearing(b, w.beams, this.fov)) * DEG;
    const dx = Math.sin(brg);
    const dz = -Math.cos(brg);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const oz = this.origin.z;
    const row = b * bins;
    const data = w.data;
    const axis = -w.tilt; // deg elevation of the beam axis
    const tanA = this.coneTan(w.beams);
    const elTop = this.elTop;

    // --- 1. Seabed profile: for each bin, the elevation at which the range
    //        sphere meets the bottom (top crossing) inside the beam ±margin.
    //        Solved by regula falsi in u = sin(elevation): f(u) = ray height −
    //        ground height is linear in u over a flat bottom (exact in one step)
    //        and nearly so for real slopes (the sector is ≈ 0.4·r wide
    //        horizontally but ≈ 0.4·r tall). 2–4 terrain samples per bin.
    const uTop = Math.sin((axis + HALF_BEAM_V + SEABED_MARGIN) * DEG);
    const uBot = Math.sin((axis - HALF_BEAM_V - SEABED_MARGIN) * DEG);
    const elSectorTop = Math.asin(uTop);
    for (let i = 0; i < bins; i++) {
      const r = (i + 0.5) * step;
      const fa0 = this.seabedGap(r, uTop, dx, dz);
      if (fa0 < 0) {
        elTop[i] = elSectorTop; // the whole sector is below the bottom
        continue;
      }
      const fb0 = this.seabedGap(r, uBot, dx, dz);
      if (fb0 >= 0) {
        elTop[i] = -Infinity; // the whole sector is above the bottom
        continue;
      }
      let ua = uTop;
      let fa = fa0;
      let ub = uBot;
      let fb = fb0;
      for (let it = 0; it < SEABED_ITERS; it++) {
        const um = ua - (fa * (ua - ub)) / (fa - fb);
        const fm = this.seabedGap(r, um, dx, dz);
        if (Math.abs(fm) < 1e-3) {
          ua = ub = um;
          fa = 0;
          fb = -1;
          break;
        }
        if (fm >= 0) {
          ua = um;
          fa = fm;
        } else {
          ub = um;
          fb = fm;
        }
      }
      elTop[i] = Math.asin(ua - (fa * (ua - ub)) / (fa - fb));
    }

    // --- 2. Narrow-phase list for this beam: colliders near the beam plane.
    const bc = this.beamCand;
    bc.length = 0;
    if (this.exactFlag.length < this.cand.length) this.exactFlag = new Uint8Array(this.cand.length * 2);
    for (let i = 0; i < this.cand.length; i++) {
      const bd = this.bounds[this.cand[i]];
      const rx = bd.x - ox;
      const rz = bd.z - oz;
      const along = rx * dx + rz * dz;
      const lat = Math.abs(rx * dz - rz * dx);
      if (along < -bd.r || lat > bd.r + 0.1 + tanA * Math.max(0, along + bd.r)) continue;
      bc.push(this.cand[i]);
    }

    // --- 3. Structures: first hit of each elevation sub-ray (occlusion between objects).
    const hc = this.hitCand;
    hc.length = 0;
    if (bc.length > 0) {
      for (let k = 0; k < EL_RAYS; k++) {
        const delta = -HALF_BEAM_V + k * EL_SPACING;
        const el = (axis + delta) * DEG;
        const ce = Math.cos(el);
        const rdx = dx * ce;
        const rdy = Math.sin(el);
        const rdz = dz * ce;
        // Seabed along this sub-ray: first bin whose bottom crossing is at or above it.
        let seabedT = Infinity;
        for (let i = 0; i < bins; i++) {
          if (elTop[i] >= el) {
            seabedT = (i + 0.5) * step;
            break;
          }
        }
        let bestT = Infinity;
        let bestCos = 0;
        let bestFill = 0;
        let bestC = -1;
        const exact = this.exactFlag;
        // Exact hits first (they bound the cone tests).
        for (let c = 0; c < bc.length; c++) {
          const col = this.colliders[bc[c]];
          const t =
            col.kind === 'box' ? rayBox(ox, oy, oz, rdx, rdy, rdz, col, 0, maxT) : rayCapsule(ox, oy, oz, rdx, rdy, rdz, col, maxT);
          exact[c] = t > 0 ? 1 : 0;
          if (t > 0) {
            if (t < bestT) {
              bestT = t;
              bestCos = hit.cos;
              bestFill = 1;
              bestC = bc[c];
            }
          }
        }
        const exactT = bestT;
        // Cone near-misses (thin or off-axis objects the exact ray missed), nearer than the exact hit.
        for (let c = 0; c < bc.length; c++) {
          if (exact[c]) continue;
          const col = this.colliders[bc[c]];
          const bd = this.bounds[bc[c]];
          const lim = Math.min(maxT, exactT);
          const ok =
            col.kind === 'box'
              ? coneBox(ox, oy, oz, rdx, rdy, rdz, col, Math.hypot(bd.x - ox, bd.y - oy, bd.z - oz) * tanA, tanA, lim)
              : coneCapsule(ox, oy, oz, rdx, rdy, rdz, col, tanA, lim);
          if (ok && hit.t < bestT - 1e-6) {
            bestT = hit.t;
            bestCos = hit.cos;
            bestFill = hit.fill;
            bestC = bc[c];
          }
        }
        if (bestC < 0) continue;
        if (hc.indexOf(bestC) < 0) hc.push(bestC);
        if (bestT >= maxT || bestT > seabedT + step) continue; // hidden by the seabed / out of range
        const echo = TS_STRUCT * bestFill * (0.2 + 0.8 * bestCos) * beamPattern(delta) * transmissionLoss(bestT);
        const i = Math.floor(bestT / step);
        if (echo > data[row + i]) data[row + i] = echo;
      }
    }

    // --- 4. Seabed echoes with terrain self-shadow and structure shadow.
    let horizon = -Infinity;
    for (let i = 0; i < bins; i++) {
      const el = elTop[i];
      if (el === -Infinity) continue;
      const visible = el >= horizon - HORIZON_TOL;
      if (el > horizon) horizon = el;
      if (!visible) continue;
      const delta = el / DEG - axis;
      if (Math.abs(delta) > HALF_BEAM_V) continue;
      const r = (i + 0.5) * step;
      const ce = Math.cos(el);
      const rdx = ce * dx;
      const rdy = Math.sin(el);
      const rdz = ce * dz;
      // Structure shadow: line of sight to the seabed point crosses a collider.
      let shadow = false;
      for (let c = 0; c < hc.length && !shadow; c++) {
        const col = this.colliders[hc[c]];
        const lim = r - 0.5 * step;
        const t = col.kind === 'box' ? rayBox(ox, oy, oz, rdx, rdy, rdz, col, 0, lim) : rayCapsule(ox, oy, oz, rdx, rdy, rdz, col, lim);
        if (t > 0) shadow = true;
      }
      if (shadow) continue;
      const hx = ox + rdx * r;
      const hz = oz + rdz * r;
      const g0 = oy + rdy * r; // on the bottom by construction (step 1)
      const gx = (this.terrainHeight(hx + 0.5, hz) - g0) / 0.5;
      const gz = (this.terrainHeight(hx, hz + 0.5) - g0) / 0.5;
      const sinGraze = Math.abs(-gx * rdx + rdy - gz * rdz) / Math.hypot(gx, 1, gz);
      const echo = (0.1 + 0.5 * Math.pow(sinGraze, 0.7)) * beamPattern(delta) * transmissionLoss(r);
      if (echo > data[row + i]) data[row + i] = echo;
    }
  }

  /** Height of the ray point (range r, u = sin(elevation)) above the bottom. Origin/dir from the current beam. */
  private seabedGap(r: number, u: number, dx: number, dz: number): number {
    const h = r * Math.sqrt(1 - u * u);
    return this.origin.y + r * u - this.terrainHeight(this.origin.x + dx * h, this.origin.z + dz * h);
  }

  draw(cssW: number, cssH: number): void {
    const c = this.canvas;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      this.cacheKey = '';
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const ping = this.front;
    const iw = Math.max(1, Math.round(cssW));
    const ih = Math.max(1, Math.round(cssH));

    // Sonar image, re-rendered only when a new ping completes (or view changes).
    if (ping) {
      const key = `${this.pingCount}|${iw}x${ih}|${this.gain}`;
      if (key !== this.cacheKey || !this.off) {
        this.renderImage(ping, iw, ih);
        this.cacheKey = key;
      }
      if (this.off) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.off, 0, 0, W, H);
      }
    }

    // Overlays in CSS px (scaled by dpr).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = sonarLayout(iw, ih, this.fov);
    const { ox, oy, R, font } = L;
    const range = ping ? ping.range : this.range;
    const heading = ping ? ping.heading : 0;
    const halfFov = (this.fov / 2) * DEG;
    const a0 = -Math.PI / 2 - halfFov;
    const a1 = -Math.PI / 2 + halfFov;
    const fontStr = (px: number) => `${px}px "IBM Plex Mono", ui-monospace, monospace`;
    const label = (txt: string, x: number, y: number) => {
      ctx.strokeText(txt, x, y);
      ctx.fillText(txt, x, y);
    };
    ctx.lineJoin = 'round';

    // Range rings at a "nice" step.
    const ringStep = range <= 10 ? 2 : range <= 20 ? 5 : 10;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150,200,255,0.30)';
    for (let m = ringStep; m <= range + 1e-6; m += ringStep) {
      ctx.beginPath();
      ctx.arc(ox, oy, (m / range) * R, a0, a1);
      ctx.stroke();
    }
    // Radial lines every 30° (relative bearing) and fan edges.
    ctx.strokeStyle = 'rgba(150,200,255,0.22)';
    for (let rb = -60; rb <= 60; rb += 30) {
      const a = -Math.PI / 2 + rb * DEG;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + Math.cos(a) * R, oy + Math.sin(a) * R);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,200,255,0.45)';
    ctx.beginPath();
    ctx.moveTo(ox + Math.cos(a0) * R, oy + Math.sin(a0) * R);
    ctx.lineTo(ox, oy);
    ctx.lineTo(ox + Math.cos(a1) * R, oy + Math.sin(a1) * R);
    ctx.stroke();
    // Bearing ticks every 10°, labels every 30° (relative, + = starboard).
    ctx.font = fontStr(font - 1);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.fillStyle = 'rgba(200,228,255,0.95)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let rb = -60; rb <= 60; rb += 10) {
      const a = -Math.PI / 2 + rb * DEG;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const len = rb % 30 === 0 ? 6 : 3;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(170,215,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(ox + ca * R, oy + sa * R);
      ctx.lineTo(ox + ca * (R + len), oy + sa * (R + len));
      ctx.stroke();
      ctx.restore();
      if (rb % 30 === 0) {
        const t = rb === 0 ? '0' : `${rb > 0 ? '+' : '−'}${Math.abs(rb)}`;
        const d = R + 7 + font * 0.7;
        label(t, ox + ca * d, oy + sa * d);
      }
    }
    // Range labels along the +30° radial (clear of the centre line where targets sit).
    ctx.textAlign = 'left';
    ctx.font = fontStr(font - 1);
    const la = -Math.PI / 2 + 30 * DEG;
    for (let m = ringStep; m <= range + 1e-6; m += ringStep) {
      const rr = (m / range) * R;
      label(m + (m + ringStep > range + 1e-6 ? ' m' : ''), ox + Math.cos(la) * rr + 3, oy + Math.sin(la) * rr - 2);
    }

    // Header bar (never clipped: compact variant / smaller font when narrow).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(0,10,28,0.78)';
    ctx.fillRect(0, 0, iw, L.header);
    const rate = this.pingRate > 0 ? this.pingRate.toFixed(1) : '--';
    const hdg = String(((Math.round(heading) % 360) + 360) % 360).padStart(3, '0');
    const variants = [
      `FLS ${this.fov}°  RNG ${range} m  GAIN ${this.gain.toFixed(1)}  TILT ${this.tilt.toFixed(0)}°  HDG ${hdg}°  ${rate} Hz`,
      `RNG ${range}m  GAIN ${this.gain.toFixed(1)}  TILT ${this.tilt.toFixed(0)}°  ${rate}Hz`,
      `R${range}m G${this.gain.toFixed(1)} T${this.tilt.toFixed(0)}°`,
    ];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(205,232,255,0.98)';
    let fpx = font;
    let text = variants[variants.length - 1];
    pick: for (; fpx >= 7; fpx--) {
      ctx.font = fontStr(fpx);
      for (const v of variants) {
        if (ctx.measureText(v).width <= iw - 10) {
          text = v;
          break pick;
        }
      }
    }
    ctx.font = fontStr(Math.max(7, fpx));
    ctx.fillText(text, 5, L.header / 2);
    if (!ping) {
      ctx.textAlign = 'center';
      ctx.font = fontStr(font);
      ctx.fillText('PINGING…', ox, oy - R / 2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private renderImage(ping: Ping, iw: number, ih: number): void {
    if (typeof document === 'undefined') return;
    if (!this.off) this.off = document.createElement('canvas');
    const off = this.off;
    if (off.width !== iw || off.height !== ih) {
      off.width = iw;
      off.height = ih;
    }
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(iw, ih);
    const px = img.data;
    const { beams, bins, data } = ping;

    // Pixel → (beam, bin) lookup, cached per geometry.
    const lkey = `${iw}x${ih}|${beams}|${bins}`;
    if (!this.lut || this.lut.key !== lkey) {
      const bf = new Float32Array(iw * ih).fill(-1000);
      const rf = new Float32Array(iw * ih);
      const { ox: cx, oy: cy, R } = sonarLayout(iw, ih, this.fov);
      for (let y = 0; y < ih; y++) {
        for (let x = 0; x < iw; x++) {
          const ddx = x + 0.5 - cx;
          const ddy = cy - (y + 0.5);
          const r = Math.hypot(ddx, ddy);
          if (r > R) continue;
          const ang = Math.atan2(ddx, ddy) / DEG;
          if (Math.abs(ang) > this.fov / 2) continue;
          bf[y * iw + x] = (ang + this.fov / 2) / (this.fov / beams) - 0.5;
          rf[y * iw + x] = (r / R) * bins - 0.5;
        }
      }
      this.lut = { key: lkey, bf, rf };
    }
    const { bf, rf } = this.lut;
    const sample = (b: number, r: number): number => {
      if (r < -0.5 || r > bins - 0.5) return 0;
      const rc = Math.max(0, Math.min(bins - 1.001, r));
      const b0 = Math.max(0, Math.min(beams - 2, Math.floor(b)));
      const r0 = Math.min(bins - 2, Math.floor(rc));
      const fb = Math.max(0, Math.min(1, b - b0));
      const fr = rc - r0;
      const i = b0 * bins + r0;
      const top = data[i] * (1 - fr) + data[i + 1] * fr;
      const bot = data[i + bins] * (1 - fr) + data[i + bins + 1] * fr;
      return top * (1 - fb) + bot * fb;
    };
    const so = this.pingCount * 37;
    const gain = this.gain;
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const p = y * iw + x;
        const o = p * 4;
        const bfv = bf[p];
        if (bfv < -999) {
          px[o] = 0;
          px[o + 1] = 0;
          px[o + 2] = 0;
          px[o + 3] = 255;
          continue;
        }
        const rr = rf[p];
        const a = sample(bfv, rr);
        const rangeFrac = Math.max(0, (rr + 0.5) / bins);
        const n = SPECKLE[(((y + so) & (SPECKLE_N - 1)) * SPECKLE_N + ((x + (so >> 3)) & (SPECKLE_N - 1)))];
        const v = sonarDisplayLevel(a, rangeFrac, gain, n);
        const li = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
        px[o] = PALETTE[li];
        px[o + 1] = PALETTE[li + 1];
        px[o + 2] = PALETTE[li + 2];
        px[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
  }
}
