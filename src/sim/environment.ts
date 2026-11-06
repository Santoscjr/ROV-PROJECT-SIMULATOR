/**
 * Seabed environment shared by the simulation and the renderer: seeded
 * terrain + a deterministic field of PHYSICAL rocks (boulders and the rock
 * berm over the export pipeline), indexed in a uniform spatial grid.
 *
 * RULE — physical vs cosmetic seabed detail:
 *  - PHYSICAL: every boulder with a size ≥ ROCK_PHYSICAL_MIN_SIZE (0.3 m) and
 *    the rock berm. Generated here from `EnvironmentConfig.seed` only — never
 *    from the graphics quality — so the physical world is identical on every
 *    machine. Each one has a collider (a horizontal capsule buried so that
 *    its cap is the visible rock), used by the ROV contacts, the altimeter,
 *    the tether and the sonar; the renderer draws the SAME list with a mesh
 *    that follows the collider surface (± ~8 % noise).
 *  - COSMETIC: cobbles / pebbles (< 0.3 m), shells, sessile life, debris.
 *    Placed by the renderer, counts depend on the graphics quality, no
 *    colliders (smaller than the hull / skid clearance and the altimeter
 *    accuracy). They must never be used for gameplay.
 */
import { terrainHeight, setTerrainSeed, getTerrainSeed, fbm, hashInt2, SITE_CENTER, DEFAULT_TERRAIN_SEED } from './terrain';
import { sedimentAt } from './sediment';
import {
  COLLIDERS,
  CONTEXT_STRUCTURES,
  LAUNCH_POINT,
  MANIFOLD,
  PIPELINE_PATH,
  PIPELINE_RADIUS,
  PLET,
  TREE,
  type CapsuleCollider,
  type Collider,
  type V3,
} from './site';
import { colliderBounds, rayDownToCollider } from '../physics/collision';
import { Vector3 } from 'three';

export interface EnvironmentConfig {
  /** Seed of the terrain relief and of the rock field. 0 = reference site. */
  seed: number;
}

export const DEFAULT_ENVIRONMENT_CONFIG: Readonly<EnvironmentConfig> = { seed: DEFAULT_TERRAIN_SEED };

/** Extent of the modelled seabed (render tiles and rock field). */
export const WORLD_BOUNDS = { minX: -140, maxX: 230, minZ: -230, maxZ: 110 } as const;

/** Rocks at least this large (characteristic radius, m) are physical. */
export const ROCK_PHYSICAL_MIN_SIZE = 0.3;
/** Number of boulders in the field (before clustering satellites). */
const BOULDER_TARGET = 240;

/** A physical boulder. Its collider is a horizontal capsule whose cap above the seabed is the rock. */
export interface Rock {
  id: number;
  x: number;
  z: number;
  /** Seabed height used as the rock's base (m). */
  ground: number;
  /** Rotation of the long axis about +Y (rad), same convention as box colliders. */
  yaw: number;
  /** Half extents of the footprint at the base: along the long axis / across (m). */
  halfLength: number;
  halfWidth: number;
  /** Height of the top above `ground` (m). */
  height: number;
  /** World y of the top. */
  top: number;
  /** Characteristic size (m): ≥ ROCK_PHYSICAL_MIN_SIZE. */
  size: number;
  collider: CapsuleCollider;
  /** Grey level multiplier for rendering (≈ 0.75–1.1). */
  tint: number;
  /** Shape seed for the visual noise (0..1). */
  shape: number;
}

/** A stone of the rock berm (visual skin of the berm colliders). */
export interface BermStone {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  tint: number;
}

/**
 * Uniform grid over the xz plane. Each collider is inserted in every cell its
 * horizontal bound overlaps; queries return each collider once (stamp).
 */
export class ColliderGrid {
  readonly colliders: readonly Collider[];
  /** Broad-phase bound (centre + radius) of each collider, same order. */
  readonly bounds: readonly { x: number; y: number; z: number; r: number }[];
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly aabb: Float64Array;
  private readonly stamp: Uint32Array;
  private stampId = 0;

  constructor(
    colliders: readonly Collider[],
    readonly cell = 8,
  ) {
    this.colliders = colliders;
    this.bounds = colliders.map(colliderBounds);
    const n = colliders.length;
    this.aabb = new Float64Array(n * 4);
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    colliders.forEach((c, i) => {
      const [a, b, cc, d] = footprint(c);
      this.aabb.set([a, b, cc, d], i * 4);
      x0 = Math.min(x0, a);
      z0 = Math.min(z0, b);
      x1 = Math.max(x1, cc);
      z1 = Math.max(z1, d);
    });
    if (n === 0) x0 = z0 = x1 = z1 = 0;
    this.minX = x0;
    this.minZ = z0;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
    const counts = new Int32Array(this.nx * this.nz + 1);
    const each = (i: number, f: (k: number) => void) => {
      const [i0, j0, i1, j1] = this.range(this.aabb[i * 4], this.aabb[i * 4 + 1], this.aabb[i * 4 + 2], this.aabb[i * 4 + 3]);
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) f(j * this.nx + ii);
    };
    for (let i = 0; i < n; i++) each(i, (k) => counts[k + 1]++);
    for (let k = 0; k < this.nx * this.nz; k++) counts[k + 1] += counts[k];
    this.start = counts.slice();
    this.items = new Int32Array(counts[this.nx * this.nz]);
    const fill = counts.slice();
    for (let i = 0; i < n; i++) each(i, (k) => (this.items[fill[k]++] = i));
    this.stamp = new Uint32Array(n);
  }

  get size(): number {
    return this.colliders.length;
  }

  private range(x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
    const c = this.cell;
    const cl = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    return [
      cl(Math.floor((x0 - this.minX) / c), this.nx),
      cl(Math.floor((z0 - this.minZ) / c), this.nz),
      cl(Math.floor((x1 - this.minX) / c), this.nx),
      cl(Math.floor((z1 - this.minZ) / c), this.nz),
    ];
  }

  /** Indices of the colliders whose horizontal footprint overlaps the box (appended to `out`). */
  queryIndices(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    if (this.colliders.length === 0) return out;
    if (maxX < this.minX || maxZ < this.minZ || minX > this.minX + this.nx * this.cell || minZ > this.minZ + this.nz * this.cell) return out;
    if (++this.stampId === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const id = this.stampId;
    const [i0, j0, i1, j1] = this.range(minX, minZ, maxX, maxZ);
    const bb = this.aabb;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        for (let p = this.start[k]; p < this.start[k + 1]; p++) {
          const c = this.items[p];
          if (this.stamp[c] === id) continue;
          this.stamp[c] = id;
          if (bb[c * 4] > maxX || bb[c * 4 + 2] < minX || bb[c * 4 + 1] > maxZ || bb[c * 4 + 3] < minZ) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  /** Colliders whose horizontal footprint overlaps the box (appended to `out`). */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[] = []): Collider[] {
    const idx = this.queryIndices(minX, minZ, maxX, maxZ, (this.tmpIdx.length = 0, this.tmpIdx));
    for (let i = 0; i < idx.length; i++) out.push(this.colliders[idx[i]]);
    return out;
  }
  private readonly tmpIdx: number[] = [];

  /** Colliders whose footprint comes within `r` of (x, z) (box test, appended to `out`). */
  near(x: number, z: number, r: number, out: Collider[] = []): Collider[] {
    return this.query(x - r, z - r, x + r, z + r, out);
  }
}

/** Horizontal AABB [minX, minZ, maxX, maxZ] of a collider. */
function footprint(c: Collider): [number, number, number, number] {
  if (c.kind === 'capsule') {
    const r = c.radius;
    return [Math.min(c.a.x, c.b.x) - r, Math.min(c.a.z, c.b.z) - r, Math.max(c.a.x, c.b.x) + r, Math.max(c.a.z, c.b.z) + r];
  }
  const cs = Math.abs(Math.cos(c.yaw));
  const sn = Math.abs(Math.sin(c.yaw));
  const ex = c.half.x * cs + c.half.z * sn;
  const ez = c.half.x * sn + c.half.z * cs;
  return [c.center.x - ex, c.center.z - ez, c.center.x + ex, c.center.z + ez];
}

export interface SeabedEnvironment {
  readonly config: Readonly<EnvironmentConfig>;
  /** Physical boulders (sorted by id). */
  readonly rocks: readonly Rock[];
  /** Rock berm over the export pipeline: colliders + the stones that render it. */
  readonly bermColliders: readonly CapsuleCollider[];
  readonly bermStones: readonly BermStone[];
  /** Every physical seabed collider (boulders, then berm): what the grid indexes. */
  readonly physicalColliders: readonly Collider[];
  /** Site structures + physical seabed colliders (for consumers that need one flat list). */
  readonly allColliders: readonly Collider[];
  readonly grid: ColliderGrid;
  /** Seabed height for this environment's seed. */
  terrainHeight(x: number, z: number): number;
  /** Physical seabed colliders overlapping an xz box (appended to `out`, which is returned). */
  queryColliders(minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[]): Collider[];
  /** Physical seabed colliders within ~r of (x, z). */
  collidersNear(x: number, z: number, r: number, out?: Collider[]): Collider[];
  /** Highest solid surface (terrain, rock, berm, structure top) at (x, z) — what a downward ray hits first from above. */
  surfaceHeight(x: number, z: number): number;
}

/** Mulberry32 PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Horizontal distance from (x, z) to a polyline. */
function distToPath(x: number, z: number, path: readonly V3[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    let t = l2 > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - a.x - abx * t, z - a.z - abz * t);
    if (d < best) best = d;
  }
  return best;
}

/** Footprints to keep clear: centre, half extents, yaw, clearance (m). */
const KEEP_CLEAR: { x: number; z: number; hx: number; hz: number; yaw: number; clear: number }[] = [
  { x: MANIFOLD.position.x, z: MANIFOLD.position.z, hx: MANIFOLD.size.x / 2, hz: MANIFOLD.size.z / 2, yaw: MANIFOLD.yaw, clear: 3 },
  { x: TREE.position.x, z: TREE.position.z, hx: TREE.size.x / 2, hz: TREE.size.z / 2, yaw: TREE.yaw, clear: 3 },
  { x: PLET.position.x, z: PLET.position.z, hx: PLET.size.x / 2, hz: PLET.size.z / 2, yaw: 0, clear: 3 },
  ...Object.values(CONTEXT_STRUCTURES).map((s) => ({ x: s.x, z: s.z, hx: s.size.x / 2 + 0.4, hz: s.size.z / 2 + 0.4, yaw: 0, clear: 3 })),
  // Training target post and gates (catalog.ts).
  { x: 46, z: -52, hx: 0.5, hz: 0.5, yaw: 0, clear: 5 },
];
/** Mooring chain lying on the seabed (render/context.ts). */
const MOORING: V3[] = Array.from({ length: 7 }, (_, i) => ({ x: -8 - i * 5, y: 0, z: -150 + i * 2 }));
/** Pipeline xz bounding box (cheap reject before the polyline distance). */
const PIPE_BOX = (() => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of PIPELINE_PATH) {
    x0 = Math.min(x0, p.x);
    z0 = Math.min(z0, p.z);
    x1 = Math.max(x1, p.x);
    z1 = Math.max(z1, p.z);
  }
  return { x0, z0, x1, z1 };
})();

/** True when a rock of horizontal radius `rad` at (x, z) would intrude on infrastructure / operating areas. */
export function rockExcluded(x: number, z: number, rad: number): boolean {
  if (Math.hypot(x - SITE_CENTER.x, z - SITE_CENTER.z) < 30 + rad) return true;
  if (Math.hypot(x - LAUNCH_POINT.x, z - LAUNCH_POINT.z) < 18 + rad) return true;
  const pc = 2.5 + rad;
  if (x > PIPE_BOX.x0 - pc && x < PIPE_BOX.x1 + pc && z > PIPE_BOX.z0 - pc && z < PIPE_BOX.z1 + pc && distToPath(x, z, PIPELINE_PATH) < pc) return true;
  if (distToPath(x, z, MOORING) < 1.5 + rad) return true;
  for (const k of KEEP_CLEAR) {
    const c = Math.cos(k.yaw);
    const s = Math.sin(k.yaw);
    const dx = x - k.x;
    const dz = z - k.z;
    const lx = Math.abs(dx * c - dz * s) - k.hx;
    const lz = Math.abs(dx * s + dz * c) - k.hz;
    if (Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < k.clear + rad) return true;
  }
  return false;
}

/**
 * Buried horizontal capsule whose cap above `ground` has the given base
 * footprint (half length a0 ≥ half width w0) and height h.
 */
export function rockCapsule(x: number, z: number, ground: number, yaw: number, a0: number, w0: number, h: number): CapsuleCollider {
  const rho = (w0 * w0 + h * h) / (2 * h);
  const cy = ground + h - rho;
  const L = Math.max(0, a0 - w0);
  const ax = Math.cos(yaw) * L;
  const az = -Math.sin(yaw) * L;
  return { kind: 'capsule', a: { x: x - ax, y: cy, z: z - az }, b: { x: x + ax, y: cy, z: z + az }, radius: rho, surface: 'rock' };
}

function generate(config: EnvironmentConfig): SeabedEnvironment {
  const seed = config.seed;
  const H = (x: number, z: number) => terrainHeight(x, z, seed);
  const r = prng(Math.imul(seed ^ 0x5eed, 2654435761) ^ 0x1337);
  const B = WORLD_BOUNDS;
  const W = B.maxX - B.minX;
  const D = B.maxZ - B.minZ;

  // --- Boulders: clustered in gravelly / rocky patches, with satellites.
  const rocks: Rock[] = [];
  const cell = 6;
  const occ = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  const fits = (x: number, z: number, rad: number) => {
    const i0 = Math.floor(x / cell);
    const j0 = Math.floor(z / cell);
    for (let j = j0 - 1; j <= j0 + 1; j++)
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        const list = occ.get(key(i, j));
        if (!list) continue;
        for (const id of list) {
          const o = rocks[id];
          if (Math.hypot(o.x - x, o.z - z) < (o.halfLength + rad) * 0.85 + 0.1) return false;
        }
      }
    return true;
  };
  const add = (x: number, z: number, size: number): boolean => {
    const slab = r() < 0.25;
    let a0 = size * (0.85 + 0.5 * r());
    let w0 = size * (0.65 + 0.35 * r());
    if (w0 > a0) [a0, w0] = [w0, a0];
    const h = Math.max(0.16, size * (slab ? 0.3 + 0.15 * r() : 0.48 + 0.34 * r()));
    const yaw = r() * Math.PI;
    const tint = 0.78 + r() * 0.3;
    const shape = r();
    if (x - a0 < B.minX || x + a0 > B.maxX || z - a0 < B.minZ || z + a0 > B.maxZ) return false;
    if (rockExcluded(x, z, a0) || !fits(x, z, Math.min(a0, 2.2))) return false;
    // Base: slightly embedded at the lowest point of the footprint (slopes).
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let g = H(x, z);
    g = Math.min(g, (H(x + c * a0, z - s * a0) + H(x - c * a0, z + s * a0) + H(x + s * w0, z + c * w0) + H(x - s * w0, z - c * w0)) / 4) - 0.03;
    const collider = rockCapsule(x, z, g, yaw, a0, w0, h);
    const id = rocks.length;
    rocks.push({ id, x, z, ground: g, yaw, halfLength: a0, halfWidth: w0, height: h, top: g + h, size, collider, tint, shape });
    const k = key(Math.floor(x / cell), Math.floor(z / cell));
    const list = occ.get(k);
    if (list) list.push(id);
    else occ.set(k, [id]);
    return true;
  };
  const o = seed * 0.0137;
  let boulders = 0;
  for (let attempt = 0; attempt < BOULDER_TARGET * 40 && boulders < BOULDER_TARGET; attempt++) {
    const x = B.minX + r() * W;
    const z = B.minZ + r() * D;
    const u = r();
    const sed = sedimentAt(x, z, seed);
    const rocky = Math.min(1, 0.04 + 2.4 * sed.gravel + 0.5 * Math.max(0, fbm(x / 25 + o + 40.2, z / 25 - o, 2) - 0.1));
    if (u > rocky) continue;
    const size = ROCK_PHYSICAL_MIN_SIZE + Math.pow(r(), 2.6) * 1.5;
    if (!add(x, z, size)) continue;
    boulders++;
    // Satellites around the larger boulders (blocks broken off / dropped together).
    if (size > 0.6) {
      const n = Math.floor(r() * 3.2);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const d = size * 1.2 + 0.5 + r() * 3;
        add(x + Math.cos(a) * d, z + Math.sin(a) * d, ROCK_PHYSICAL_MIN_SIZE + r() * size * 0.5);
      }
    }
  }

  // --- Rock berm (stabilisation dump) over a stretch of the export pipeline.
  const bermA = Math.floor(PIPELINE_PATH.length * 0.68);
  const bermB = Math.floor(PIPELINE_PATH.length * 0.76);
  const bermH = PIPELINE_RADIUS * 2 + 0.25;
  const bermW = 2.1;
  const bermRho = (bermW * bermW + bermH * bermH) / (2 * bermH);
  const bermColliders: CapsuleCollider[] = [];
  const bermPts = PIPELINE_PATH.slice(bermA, bermB + 1).map((p) => ({ x: p.x, z: p.z, y: H(p.x, p.z) + bermH - bermRho }));
  for (let i = 0; i < bermPts.length - 1; i++)
    bermColliders.push({ kind: 'capsule', a: bermPts[i], b: bermPts[i + 1], radius: bermRho, surface: 'rock' });
  const bermStones: BermStone[] = [];
  const top = new Vector3();
  const bermTop = (x: number, z: number): number | null => {
    top.set(x, 0, z);
    let best: number | null = null;
    for (const c of bermColliders) {
      const d = rayDownToCollider(top, c);
      if (d !== null && (best === null || -d > best)) best = -d;
    }
    return best;
  };
  for (let i = 0, tries = 0; i < 340 && tries < 3000; tries++) {
    const t = r() * (bermPts.length - 1);
    const k = Math.min(bermPts.length - 2, Math.floor(t));
    const f = t - k;
    const pa = bermPts[k];
    const pb = bermPts[k + 1];
    const dx = pb.x - pa.x;
    const dz = pb.z - pa.z;
    const l = Math.hypot(dx, dz) || 1;
    const lat = (r() - 0.5) * 2 * (bermW + 0.15);
    const ext = k === 0 && f < 0.1 ? -r() * bermW : k === bermPts.length - 2 && f > 0.9 ? r() * bermW : 0;
    const x = pa.x + dx * f + (dx / l) * ext - (dz / l) * lat;
    const z = pa.z + dz * f + (dz / l) * ext + (dx / l) * lat;
    const surf = bermTop(x, z);
    const g = H(x, z);
    if (surf === null || surf < g - 0.02) continue;
    const size = 0.14 + r() * 0.2;
    bermStones.push({
      x,
      y: Math.max(g, surf - size * (0.35 + 0.3 * r())),
      z,
      yaw: r() * Math.PI * 2,
      sx: size,
      sy: size * 0.75,
      sz: size * (0.8 + r() * 0.4),
      tint: 0.72 + r() * 0.2,
    });
    i++;
  }

  const physicalColliders: Collider[] = [...rocks.map((k) => k.collider), ...bermColliders];
  const grid = new ColliderGrid(physicalColliders, 8);
  const allColliders: Collider[] = [...COLLIDERS, ...physicalColliders];
  const rayO = new Vector3();
  const tmp: Collider[] = [];
  const env: SeabedEnvironment = {
    config: Object.freeze({ ...config }),
    rocks,
    bermColliders,
    bermStones,
    physicalColliders,
    allColliders,
    grid,
    terrainHeight: H,
    queryColliders: (minX, minZ, maxX, maxZ, out) => grid.query(minX, minZ, maxX, maxZ, out),
    collidersNear: (x, z, rr, out = []) => grid.near(x, z, rr, out),
    surfaceHeight: (x, z) => {
      let h = H(x, z);
      rayO.set(x, 1e4, z);
      tmp.length = 0;
      grid.query(x, z, x, z, tmp);
      for (const c of tmp) {
        const d = rayDownToCollider(rayO, c);
        if (d !== null) h = Math.max(h, 1e4 - d);
      }
      for (const c of COLLIDERS) {
        const d = rayDownToCollider(rayO, c);
        if (d !== null) h = Math.max(h, 1e4 - d);
      }
      return h;
    },
  };
  return env;
}

const cache = new Map<number, SeabedEnvironment>();

/** Environment for a config (memoised per seed; deterministic, quality independent). */
export function getEnvironment(config: Partial<EnvironmentConfig> = {}): SeabedEnvironment {
  const seed = Math.trunc(config.seed ?? DEFAULT_ENVIRONMENT_CONFIG.seed);
  let env = cache.get(seed);
  if (!env) {
    env = generate({ seed });
    cache.set(seed, env);
  }
  return env;
}

/**
 * Select the environment of the session: sets the terrain seed used by every
 * `terrainHeight(x, z)` call and returns the environment. Call BEFORE building
 * the World (seabed) and the Simulation; rebuild both after changing it.
 */
export function configureEnvironment(config: Partial<EnvironmentConfig> = {}): SeabedEnvironment {
  const env = getEnvironment(config);
  setTerrainSeed(env.config.seed);
  return env;
}

/** Environment of the active terrain seed. */
export function activeEnvironment(): SeabedEnvironment {
  return getEnvironment({ seed: getTerrainSeed() });
}

/** Deterministic per-seed hash helper for render-side placement keyed to the environment. */
export function environmentHash(seed: number, a: number, b: number): number {
  return hashInt2(a * 31 + seed, b * 17 - seed);
}
