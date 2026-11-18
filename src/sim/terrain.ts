/**
 * Deterministic seabed height field shared by physics (altimeter, contacts),
 * the tether, the sonar and rendering (terrain mesh). World frame: +Y up,
 * water surface at y = 0, north = -Z, east = +X.
 *
 * Seeds: `terrainHeight(x, z, seed)`; the seed defaults to the ACTIVE seed
 * (`setTerrainSeed`, normally set through `configureEnvironment` in
 * environment.ts before the world and the simulation are built). Seed 0 is
 * the reference site. The seed changes:
 *  - the regional relief (noise domain offset), except inside the PROTECTED
 *    zones (production site, export pipeline + PLET corridor, launch area,
 *    training field), which keep the seed-0 relief so that everything placed
 *    at module load (structures, pipeline, mission waypoints) stays valid;
 *  - the secondary relief layer (sand waves in sandy areas, mounds and
 *    pockmarks), which is zero inside the protected zones for every seed.
 * Inside the protected zones the height is therefore the original v3.1
 * height for every seed (verified by tests/terrainSeed.test.ts).
 */
import { sedimentAt } from './sediment';

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [-1, 1]. */
export function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) * 2 - 1;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq + o * 17.3, z * freq - o * 11.1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Deterministic hash in [0, 1) of two integers (exported for seeded generators). */
export function hashInt2(a: number, b: number): number {
  return hash2(a | 0, b | 0);
}

/** Centre of the production site (flattened area). */
export const SITE_CENTER = { x: 24, z: -84 };
export const SITE_BASE_DEPTH = 121;
const SITE_FLAT_RADIUS = 26;
const SITE_BLEND_RADIUS = 55;

/** Local depressions (free span under the pipeline). */
export const DEPRESSIONS = [{ x: 74, z: -71, rx: 7, rz: 4.5, depth: 1.6 }];

/** Seed of the reference site (heights identical to v3.1). */
export const DEFAULT_TERRAIN_SEED = 0;
let activeSeed = DEFAULT_TERRAIN_SEED;

/** Select the seed used by `terrainHeight` when no seed is given. Call before building world/simulation. */
export function setTerrainSeed(seed: number): void {
  activeSeed = Number.isFinite(seed) ? Math.trunc(seed) : DEFAULT_TERRAIN_SEED;
}

export function getTerrainSeed(): number {
  return activeSeed;
}

/**
 * Zones whose relief never changes with the seed and which carry no secondary
 * relief: capsules (segment a→b) fully protected within r0, blending out at r1.
 * Coordinates mirror site.ts (which cannot be imported here: it samples the
 * terrain at module load); tests/terrainSeed.test.ts checks they cover it.
 */
export const PROTECTED_ZONES: readonly { ax: number; az: number; bx: number; bz: number; r0: number; r1: number }[] = [
  // Production site (flattened disc + blend ring) and its margin.
  { ax: SITE_CENTER.x, az: SITE_CENTER.z, bx: SITE_CENTER.x, bz: SITE_CENTER.z, r0: SITE_BLEND_RADIUS + 4, r1: SITE_BLEND_RADIUS + 18 },
  // Export pipeline (manifold hub → PLET, ±3 m meander) and the PLET.
  { ax: 33.9, az: -80.75, bx: 123, bz: -60, r0: 10, r1: 26 },
  // Launch & recovery / TMS area under the vessel.
  { ax: 13.5, az: 6, bx: 13.5, bz: 6, r0: 16, r1: 36 },
  // Training field (start, gates and target post).
  { ax: 20, az: -16, bx: 46, bz: -52, r0: 12, r1: 28 },
];

/** 1 inside a protected zone, 0 well outside, smooth in between. */
export function protectedWeight(x: number, z: number): number {
  let w = 0;
  for (let i = 0; i < PROTECTED_ZONES.length; i++) {
    const p = PROTECTED_ZONES[i];
    const abx = p.bx - p.ax;
    const abz = p.bz - p.az;
    const l2 = abx * abx + abz * abz;
    let t = l2 > 0 ? ((x - p.ax) * abx + (z - p.az) * abz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - p.ax - abx * t;
    const ez = z - p.az - abz * t;
    const d2 = ex * ex + ez * ez;
    if (d2 >= p.r1 * p.r1) continue;
    const d = Math.sqrt(d2);
    if (d <= p.r0) return 1;
    if (d < p.r1) w = Math.max(w, 1 - smooth((d - p.r0) / (p.r1 - p.r0)));
  }
  return w;
}

/** Noise-domain offset of a seed (exactly 0 for seed 0). */
function seedOffset(seed: number): [number, number] {
  if (seed === 0) return [0, 0];
  return [(hash2(seed, 91) - 0.5) * 20000, (hash2(seed, 37) - 0.5) * 20000];
}
let cachedSeed = 0;
let cachedOff: [number, number] = [0, 0];
function offsetOf(seed: number): [number, number] {
  if (seed !== cachedSeed) {
    cachedSeed = seed;
    cachedOff = seedOffset(seed);
  }
  return cachedOff;
}

/** Regional relief (v3.1 formula; the noise domain is shifted by the seed offset). */
function regionalRelief(x: number, z: number, ox: number, oz: number): number {
  let h = -113 - -z * 0.06 - x * 0.015;
  h += fbm((x + ox) / 45, (z + oz) / 45, 4) * 3.2;
  h += fbm((x + ox) / 9, (z + oz) / 9, 2) * 0.35;
  // Sand ripples.
  h += Math.sin(x * 0.9 + z * 0.35 + fbm((x + ox) / 20, (z + oz) / 20, 2) * 3) * 0.04;
  return h;
}

/** Cell size of the mound / pockmark lattice (m). */
const FEATURE_CELL = 30;

/**
 * Secondary relief (m), seed-dependent, applied outside the protected zones:
 *  - sand waves (λ ≈ 11 m, ≤ ±0.16 m, asymmetric) where sedimentAt() is sandy,
 *    crests roughly across the prevailing current, slowly wandering;
 *  - isolated low mounds (sand/gravel) and pockmarks (mud), 2.5–6 m radius;
 *  - a slightly rougher micro-relief on gravel.
 */
// --- Sediment lattice: sedimentAt() sampled every SED_STEP m and interpolated
// bilinearly for the relief (sediment varies over 18–60 m; sampling it at
// every height query doubled the cost of the sonar's terrain sampling).
// Deterministic: a pure function of the seed, filled lazily.
const SED_STEP = 4;
const SED_X0 = -180;
const SED_Z0 = -270;
const SED_NX = 121; // covers x ∈ [-180, 300]
const SED_NZ = 111; // covers z ∈ [-270, 170]
const sedLattices = new Map<number, Float32Array>();
const _sed = { mud: 0, sand: 0, gravel: 0 };

function sedLattice(seed: number): Float32Array {
  let g = sedLattices.get(seed);
  if (!g) {
    if (sedLattices.size >= 4) sedLattices.delete(sedLattices.keys().next().value as number);
    g = new Float32Array(SED_NX * SED_NZ * 3).fill(NaN);
    sedLattices.set(seed, g);
  }
  return g;
}

/** Sediment mix for the relief: bilinear in the lattice of sedimentAt() (exact outside the lattice). */
export function sedimentSmooth(x: number, z: number, seed: number, out = _sed): { mud: number; sand: number; gravel: number } {
  const fx = (x - SED_X0) / SED_STEP;
  const fz = (z - SED_Z0) / SED_STEP;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= SED_NX - 1 || j >= SED_NZ - 1) {
    const m = sedimentAt(x, z, seed);
    out.mud = m.mud;
    out.sand = m.sand;
    out.gravel = m.gravel;
    return out;
  }
  const g = sedLattice(seed);
  const tx = fx - i;
  const tz = fz - j;
  out.mud = out.sand = out.gravel = 0;
  for (let c = 0; c < 4; c++) {
    const ii = i + (c & 1);
    const jj = j + (c >> 1);
    const k = (jj * SED_NX + ii) * 3;
    if (Number.isNaN(g[k])) {
      const m = sedimentAt(SED_X0 + ii * SED_STEP, SED_Z0 + jj * SED_STEP, seed);
      g[k] = m.mud;
      g[k + 1] = m.sand;
      g[k + 2] = m.gravel;
    }
    const w = (c & 1 ? tx : 1 - tx) * (c >> 1 ? tz : 1 - tz);
    out.mud += g[k] * w;
    out.sand += g[k + 1] * w;
    out.gravel += g[k + 2] * w;
  }
  return out;
}

function secondaryRelief(x: number, z: number, seed: number, ox: number, oz: number): number {
  const sed = sedimentSmooth(x, z, seed);
  let h = 0;
  const sw = sed.sand <= 0.45 ? 0 : sed.sand >= 0.85 ? 1 : smooth((sed.sand - 0.45) / 0.4);
  if (sw > 0) {
    const ang = 0.37 + valueNoise((x + ox) / 70, (z + oz) / 70) * 0.5;
    const ph = (x * Math.cos(ang) + z * Math.sin(ang)) * ((2 * Math.PI) / 11) + valueNoise((x + ox) / 25 + 5.3, (z + oz) / 25) * 2.5;
    // Gentle stoss side, steeper lee side.
    h += sw * 0.13 * (Math.sin(ph) + 0.22 * Math.sin(2 * ph + 1.3));
  }
  // Mounds / pockmarks: at most one feature per cell, centred well inside it.
  const cx = Math.floor((x + ox) / FEATURE_CELL);
  const cz = Math.floor((z + oz) / FEATURE_CELL);
  const k = hash2(cx * 7 + seed, cz * 13 - seed);
  if (k < 0.38) {
    const fx = cx * FEATURE_CELL - ox + 8 + hash2(cx + 101, cz) * 14;
    const fz = cz * FEATURE_CELL - oz + 8 + hash2(cx, cz + 203) * 14;
    const R = 2.5 + hash2(cx + 7, cz + 11) * 3.5;
    const q = ((x - fx) * (x - fx) + (z - fz) * (z - fz)) / (R * R);
    if (q < 1) {
      const f = (1 - q) * (1 - q);
      // Pockmark in mud, low mound in sand / gravel; blended continuously across the transition.
      const pit = -(0.22 + 0.3 * hash2(cx + 3, cz + 5));
      const mound = 0.12 + 0.22 * hash2(cx + 5, cz + 3);
      const mm = sed.mud <= 0.35 ? 0 : sed.mud >= 0.65 ? 1 : smooth((sed.mud - 0.35) / 0.3);
      const amp = mound + (pit - mound) * mm;
      h += amp * f;
    }
  }
  if (sed.gravel > 0.05) h += sed.gravel * fbm((x + ox) / 3.5 + 9.1, (z + oz) / 3.5, 2) * 0.12;
  return h;
}

export function terrainHeight(x: number, z: number, seed: number = activeSeed): number {
  const dx = x - SITE_CENTER.x;
  const dz = z - SITE_CENTER.z;
  const r = Math.sqrt(dx * dx + dz * dz);
  let h: number;
  if (r <= SITE_FLAT_RADIUS) {
    // Flattened site area (seabed prepared for the subsea equipment): the
    // regional relief is fully replaced, skip computing it.
    h = -SITE_BASE_DEPTH + fbm(x / 7, z / 7, 2) * 0.12;
  } else {
    // Reference (seed-0) regional relief; other seeds replace it outside the protected zones.
    h = regionalRelief(x, z, 0, 0);
    const w = protectedWeight(x, z);
    if (w < 1) {
      const [ox, oz] = offsetOf(seed);
      if (seed !== 0) {
        const hs = regionalRelief(x, z, ox, oz);
        h = hs + (h - hs) * w;
      }
      h += secondaryRelief(x, z, seed, ox, oz) * (1 - w);
    }
    if (r < SITE_BLEND_RADIUS) {
      const flat = -SITE_BASE_DEPTH + fbm(x / 7, z / 7, 2) * 0.12;
      const t = 1 - smooth((r - SITE_FLAT_RADIUS) / (SITE_BLEND_RADIUS - SITE_FLAT_RADIUS));
      h = h + (flat - h) * t;
    }
  }
  for (const d of DEPRESSIONS) {
    const q = ((x - d.x) / d.rx) ** 2 + ((z - d.z) / d.rz) ** 2;
    if (q < 1) h -= d.depth * smooth(1 - q);
  }
  return h;
}

/** Approximate surface normal by central differences. */
export function terrainNormal(x: number, z: number, e = 0.5, seed: number = activeSeed): [number, number, number] {
  const hx = terrainHeight(x + e, z, seed) - terrainHeight(x - e, z, seed);
  const hz = terrainHeight(x, z + e, seed) - terrainHeight(x, z - e, seed);
  const nx = -hx;
  const ny = 2 * e;
  const nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}
