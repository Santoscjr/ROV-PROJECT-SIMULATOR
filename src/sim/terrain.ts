/**
 * Deterministic seabed height field shared by physics (altimeter, contacts)
 * and rendering (terrain mesh). World frame: +Y up, water surface at y = 0,
 * north = -Z, east = +X.
 */

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

/** Centre of the production site (flattened area). */
export const SITE_CENTER = { x: 24, z: -84 };
export const SITE_BASE_DEPTH = 121;
const SITE_FLAT_RADIUS = 26;
const SITE_BLEND_RADIUS = 55;

/** Local depressions (free span under the pipeline). */
export const DEPRESSIONS = [{ x: 74, z: -71, rx: 7, rz: 4.5, depth: 1.6 }];

export function terrainHeight(x: number, z: number): number {
  // Gentle regional slope deepening towards the north-east, plus relief.
  let h = -113 - (-z) * 0.06 - x * 0.015;
  h += fbm(x / 45, z / 45, 4) * 3.2;
  h += fbm(x / 9, z / 9, 2) * 0.35;
  // Sand ripples.
  h += Math.sin(x * 0.9 + z * 0.35 + fbm(x / 20, z / 20, 2) * 3) * 0.04;

  // Flatten the site area (seabed prepared for the subsea equipment).
  const dx = x - SITE_CENTER.x;
  const dz = z - SITE_CENTER.z;
  const r = Math.hypot(dx, dz);
  if (r < SITE_BLEND_RADIUS) {
    const flat = -SITE_BASE_DEPTH + fbm(x / 7, z / 7, 2) * 0.12;
    const t = r <= SITE_FLAT_RADIUS ? 1 : 1 - smooth((r - SITE_FLAT_RADIUS) / (SITE_BLEND_RADIUS - SITE_FLAT_RADIUS));
    h = h + (flat - h) * t;
  }
  for (const d of DEPRESSIONS) {
    const q = ((x - d.x) / d.rx) ** 2 + ((z - d.z) / d.rz) ** 2;
    if (q < 1) h -= d.depth * smooth(1 - q);
  }
  return h;
}

/** Approximate surface normal by central differences. */
export function terrainNormal(x: number, z: number, e = 0.5): [number, number, number] {
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  const nx = -hx;
  const ny = 2 * e;
  const nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}
