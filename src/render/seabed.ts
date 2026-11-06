import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  RGBADepthPacking,
  SphereGeometry,
  TorusGeometry,
  BoxGeometry,
  Vector2,
  Vector3,
  Vector4,
  type Material,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SITE_CENTER, fbm } from '../sim/terrain';
import { sedimentAt } from '../sim/sediment';
import { LAUNCH_POINT, MANIFOLD, PIPELINE_PATH, PLET, TREE, type Collider } from '../sim/site';
import { WORLD_BOUNDS, activeEnvironment, rockExcluded, type Rock, type SeabedEnvironment } from '../sim/environment';
import { NOISE_GLSL, PERTURB_GLSL, fouledMaterial, makeSandTextures } from './materials';
import type { GraphicsQuality } from '../config/settings';

/**
 * Seabed rendering: chunked terrain with distance LOD loaded progressively
 * around a focus point, physical boulders + rock berm drawn from the shared
 * environment (sim/environment.ts — the same list the physics, altimeter,
 * tether and sonar use, identical for every graphics quality), and cosmetic
 * detail (cobbles, shells, sessile life, debris) whose density follows the
 * graphics quality. See environment.ts for the physical/cosmetic rule.
 */

export const SEABED_BOUNDS = WORLD_BOUNDS;

/** Edge length of a terrain tile (m). Tiles are aligned on SEABED_BOUNDS.min. */
export const TILE_SIZE = 32;

const COBBLES: Record<GraphicsQuality, number> = { low: 220, medium: 650, high: 1300 };
const LIFE: Record<GraphicsQuality, number> = { low: 150, medium: 450, high: 900 };
const SHELLS: Record<GraphicsQuality, number> = { low: 150, medium: 500, high: 1000 };
/** Rock meshes are grouped into chunks of this size (m) for culling. */
const ROCK_CHUNK = 96;

/** Terrain LOD settings per quality: segments of a finest tile and the LOD radii (m). */
const LOD_Q: Record<GraphicsQuality, { segments0: number; radii: [number, number, number] }> = {
  low: { segments0: 16, radii: [36, 80, 150] },
  medium: { segments0: 32, radii: [44, 96, 170] },
  high: { segments0: 32, radii: [64, 120, 200] },
};

/** An object hidden when the camera is further than the water lets one see. */
export interface Cullable {
  object: Object3D;
  box: Box3;
}

export interface SeabedStats {
  /** Terrain tiles currently loaded. */
  loadedTiles: number;
  /** Tiles whose LOD differs from the wanted one or that are missing (work queued). */
  pending: number;
  generated: number;
  disposed: number;
  /** Generation time of a tile (ms): last update total, worst tile, mean. */
  lastUpdateMs: number;
  maxTileMs: number;
  meanTileMs: number;
  /** Vertices of the loaded terrain. */
  vertices: number;
}

export interface SeabedBuild {
  group: Group;
  /**
   * Live list (the same array for the life of the build): terrain tiles are
   * added / removed as they load / unload, rock and debris groups stay.
   */
  cullables: Cullable[];
  /**
   * Stream the terrain around `focus` (call every frame with the main camera
   * or the vehicle position): LOD by distance, at most a few tiles generated
   * per call (time-budgeted), far tiles disposed, the operating area always
   * kept.
   */
  update(focus: { x: number; z: number }): void;
  /** Free every geometry / material of the seabed. */
  dispose(): void;
  readonly stats: SeabedStats;
  readonly environment: SeabedEnvironment;
}

export interface SeabedOptions {
  /** Environment (seed) to draw; default: the active one (configureEnvironment). */
  environment?: SeabedEnvironment;
  /** Initial focus: tiles around it are built synchronously. Default: the site centre. */
  focus?: { x: number; z: number };
  lod?: Partial<TerrainLodOptions>;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- Terrain tiles ---------------------------------------------------------------

/** Sediment albedo (linear multipliers of the sand texture): mud, sand, gravel. */
const ALBEDO_MUD = [0.7, 0.685, 0.62];
const ALBEDO_SAND = [0.9, 0.86, 0.74];
const ALBEDO_GRAVEL = [0.74, 0.72, 0.68];

/** Skirt depth (m) hiding cracks against coarser neighbours, for a vertex spacing. */
export function skirtDepth(spacing: number): number {
  return 0.25 + spacing * 0.22;
}

/**
 * Geometry of a terrain tile [x0, x0+size] × [z0, z0+size] with `segs`
 * segments per side: heights sampled exactly at the grid points (identical on
 * shared edges), normals by central differences over a one-cell border
 * (seamless between tiles of the same LOD), sediment mix as an attribute
 * (`aSed`: mud, sand, gravel) and albedo as vertex colour, plus a skirt
 * hanging `skirt` m below each edge.
 */
export function buildTerrainTile(
  H: (x: number, z: number) => number,
  seed: number,
  x0: number,
  z0: number,
  size: number,
  segs: number,
  skirt = skirtDepth(size / segs),
): BufferGeometry {
  const n = segs + 1;
  const s = size / segs;
  const gw = n + 2;
  const hgt = new Float64Array(gw * gw);
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) hgt[(j + 1) * gw + (i + 1)] = H(x0 + i * s, z0 + j * s);
  const Hg = (i: number, j: number) => hgt[(j + 1) * gw + (i + 1)];
  const skirtCount = 4 * n;
  const count = n * n + skirtCount;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const sed = new Float32Array(count * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = x0 + i * s;
      const z = z0 + j * s;
      pos[k * 3] = x;
      pos[k * 3 + 1] = Hg(i, j);
      pos[k * 3 + 2] = z;
      let nx = -(Hg(i + 1, j) - Hg(i - 1, j)) / (2 * s);
      let nz = -(Hg(i, j + 1) - Hg(i, j - 1)) / (2 * s);
      const l = Math.hypot(nx, 1, nz);
      nx /= l;
      nz /= l;
      nrm[k * 3] = nx;
      nrm[k * 3 + 1] = 1 / l;
      nrm[k * 3 + 2] = nz;
      const m = sedimentAt(x, z, seed);
      sed[k * 3] = m.mud;
      sed[k * 3 + 1] = m.sand;
      sed[k * 3 + 2] = m.gravel;
      // Albedo: sediment mix, broad patches and a finer mottling (silt / shell sand).
      const a = fbm(x / 14, z / 14, 3);
      const f = fbm(x / 3.5 + 40, z / 3.5, 2);
      const v = 1 + a * 0.13 + f * 0.06;
      for (let c = 0; c < 3; c++) col[k * 3 + c] = (m.mud * ALBEDO_MUD[c] + m.sand * ALBEDO_SAND[c] + m.gravel * ALBEDO_GRAVEL[c]) * v * (c === 2 ? 1 + a * 0.02 : 1);
    }
  }
  // Skirt: a copy of each edge vertex lowered by `skirt` (same normal / colour).
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i < n; i++) {
    edges[0].push(i); // z = z0
    edges[1].push((n - 1) * n + i); // z = z0 + size
    edges[2].push(i * n); // x = x0
    edges[3].push(i * n + n - 1); // x = x0 + size
  }
  let sk = n * n;
  const index: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  edges.forEach((edge, e) => {
    const base = sk;
    for (const k of edge) {
      pos[sk * 3] = pos[k * 3];
      pos[sk * 3 + 1] = pos[k * 3 + 1] - skirt;
      pos[sk * 3 + 2] = pos[k * 3 + 2];
      for (let c = 0; c < 3; c++) {
        nrm[sk * 3 + c] = nrm[k * 3 + c];
        col[sk * 3 + c] = col[k * 3 + c];
        sed[sk * 3 + c] = sed[k * 3 + c];
      }
      sk++;
    }
    // Wind outwards (visible from outside the tile); double-sided not needed.
    const flip = e === 1 || e === 2;
    for (let i = 0; i < segs; i++) {
      const t0 = edge[i];
      const t1 = edge[i + 1];
      const b0 = base + i;
      const b1 = base + i + 1;
      if (flip) index.push(t0, t1, b0, t1, b1, b0);
      else index.push(t0, b0, t1, t1, b0, b1);
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nrm, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setAttribute('aSed', new BufferAttribute(sed, 3));
  geo.setIndex(count > 65535 ? new BufferAttribute(new Uint32Array(index), 1) : new BufferAttribute(new Uint16Array(index), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export interface TerrainLodOptions {
  tileSize: number;
  /** Segments per side of a finest (LOD 0) tile; LOD k has segments0 >> k (min 4). */
  segments0: number;
  /** Horizontal distance focus → tile (m) below which LOD 0, 1, 2 are used; LOD 3 beyond. */
  radii: [number, number, number];
  /** Tiles farther than this are disposed (except the operating area). */
  unloadDistance: number;
  /** Extra distance before a tile is coarsened / unloaded (avoids thrashing at a boundary). */
  hysteresis: number;
  /** At most this many tiles (re)built per update... */
  maxTilesPerUpdate: number;
  /** ...and no new tile started once this much time (ms) was spent in the update. */
  budgetMs: number;
}

interface TileRecord {
  i: number;
  j: number;
  lod: number;
  mesh: Mesh;
  cull: Cullable;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Streams terrain tiles around a focus point. Pure geometry + scene graph, no
 * DOM: usable in tests with any material.
 */
export class TerrainTiler {
  readonly opts: TerrainLodOptions;
  readonly tiles = new Map<number, TileRecord>();
  readonly nx: number;
  readonly nz: number;
  readonly stats: SeabedStats = { loadedTiles: 0, pending: 0, generated: 0, disposed: 0, lastUpdateMs: 0, maxTileMs: 0, meanTileMs: 0, vertices: 0 };
  private totalTileMs = 0;
  private readonly core: Uint8Array;
  private readonly H: (x: number, z: number) => number;

  constructor(
    readonly env: SeabedEnvironment,
    private readonly material: Material,
    private readonly group: Group,
    private readonly cullables: Cullable[],
    opts: Partial<TerrainLodOptions> = {},
  ) {
    this.opts = {
      tileSize: TILE_SIZE,
      segments0: 32,
      radii: [64, 120, 200],
      unloadDistance: 260,
      hysteresis: 8,
      maxTilesPerUpdate: 2,
      budgetMs: 2.5,
      ...opts,
    };
    this.H = env.terrainHeight;
    const T = this.opts.tileSize;
    this.nx = Math.ceil((SEABED_BOUNDS.maxX - SEABED_BOUNDS.minX) / T);
    this.nz = Math.ceil((SEABED_BOUNDS.maxZ - SEABED_BOUNDS.minZ) / T);
    // Operating area, always loaded: site, launch / TMS column, pipeline + PLET.
    this.core = new Uint8Array(this.nx * this.nz);
    const pts: { x: number; z: number; r: number }[] = [
      { x: SITE_CENTER.x, z: SITE_CENTER.z, r: 60 },
      { x: LAUNCH_POINT.x, z: LAUNCH_POINT.z, r: 24 },
      ...PIPELINE_PATH.filter((_, k) => k % 6 === 0).map((p) => ({ x: p.x, z: p.z, r: 12 })),
      { x: PLET.position.x, z: PLET.position.z, r: 12 },
    ];
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) if (pts.some((p) => this.rectDistance(i, j, p) < p.r)) this.core[j * this.nx + i] = 1;
  }

  /** World rectangle of tile (i, j). */
  tileOrigin(i: number, j: number): { x0: number; z0: number } {
    return { x0: SEABED_BOUNDS.minX + i * this.opts.tileSize, z0: SEABED_BOUNDS.minZ + j * this.opts.tileSize };
  }

  segmentsFor(lod: number): number {
    return Math.max(4, this.opts.segments0 >> lod);
  }

  isCore(i: number, j: number): boolean {
    return this.core[j * this.nx + i] === 1;
  }

  /** Horizontal distance from a point to tile (i, j) (0 inside). */
  rectDistance(i: number, j: number, p: { x: number; z: number }): number {
    const { x0, z0 } = this.tileOrigin(i, j);
    const T = this.opts.tileSize;
    const dx = Math.max(x0 - p.x, 0, p.x - (x0 + T));
    const dz = Math.max(z0 - p.z, 0, p.z - (z0 + T));
    return Math.hypot(dx, dz);
  }

  /** Wanted LOD of a tile for a focus (-1 = not loaded), with hysteresis against its current LOD. */
  wantedLod(i: number, j: number, focus: { x: number; z: number }, current = -1): number {
    const d = this.rectDistance(i, j, focus);
    const o = this.opts;
    const lodAt = (dd: number) => (dd < o.radii[0] ? 0 : dd < o.radii[1] ? 1 : dd < o.radii[2] ? 2 : 3);
    let lod = lodAt(d);
    // Keep the current (finer) LOD until clearly beyond its radius.
    if (current >= 0 && lod > current && lodAt(d - o.hysteresis) <= current) lod = current;
    const unload = current >= 0 ? o.unloadDistance + o.hysteresis : o.unloadDistance;
    if (d > unload && !this.isCore(i, j)) return -1;
    return lod;
  }

  /**
   * Bring the loaded set towards the wanted one for `focus`. Unloads are
   * immediate; (re)builds go nearest first, limited per call unless
   * `unlimited` (initial build).
   */
  update(focus: { x: number; z: number }, unlimited = false): void {
    const t0 = now();
    const work: { i: number; j: number; lod: number; d: number; missing: boolean }[] = [];
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const key = j * this.nx + i;
        const rec = this.tiles.get(key);
        const want = this.wantedLod(i, j, focus, rec ? rec.lod : -1);
        if (want < 0) {
          if (rec) this.unload(key, rec);
          continue;
        }
        if (!rec || rec.lod !== want) work.push({ i, j, lod: want, d: this.rectDistance(i, j, focus), missing: !rec });
      }
    }
    // Missing tiles first, then refinements before coarsenings, nearest first.
    work.sort((a, b) => Number(b.missing) - Number(a.missing) || a.d - b.d);
    let built = 0;
    for (const w of work) {
      if (!unlimited && (built >= this.opts.maxTilesPerUpdate || (built > 0 && now() - t0 > this.opts.budgetMs))) break;
      this.build(w.i, w.j, w.lod);
      built++;
    }
    this.stats.pending = work.length - built;
    this.stats.loadedTiles = this.tiles.size;
    this.stats.lastUpdateMs = now() - t0;
  }

  private build(i: number, j: number, lod: number): void {
    const t0 = now();
    const key = j * this.nx + i;
    const { x0, z0 } = this.tileOrigin(i, j);
    const geo = buildTerrainTile(this.H, this.env.config.seed, x0, z0, this.opts.tileSize, this.segmentsFor(lod));
    let rec = this.tiles.get(key);
    if (rec) {
      this.stats.vertices -= rec.mesh.geometry.attributes.position.count;
      rec.mesh.geometry.dispose();
      this.stats.disposed++;
      rec.mesh.geometry = geo;
      rec.lod = lod;
      rec.cull.box.copy(geo.boundingBox!);
    } else {
      const mesh = new Mesh(geo, this.material);
      mesh.receiveShadow = true;
      mesh.name = 'terrain';
      mesh.matrixAutoUpdate = false;
      mesh.userData.tile = [i, j];
      this.group.add(mesh);
      rec = { i, j, lod, mesh, cull: { object: mesh, box: geo.boundingBox!.clone() } };
      this.tiles.set(key, rec);
      this.cullables.push(rec.cull);
    }
    this.stats.vertices += geo.attributes.position.count;
    const dt = now() - t0;
    this.stats.generated++;
    this.totalTileMs += dt;
    this.stats.maxTileMs = Math.max(this.stats.maxTileMs, dt);
    this.stats.meanTileMs = this.totalTileMs / this.stats.generated;
  }

  private unload(key: number, rec: TileRecord): void {
    this.group.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    this.stats.vertices -= rec.mesh.geometry.attributes.position.count;
    const k = this.cullables.indexOf(rec.cull);
    if (k >= 0) this.cullables.splice(k, 1);
    this.tiles.delete(key);
    this.stats.disposed++;
  }

  dispose(): void {
    for (const [key, rec] of [...this.tiles]) this.unload(key, rec);
  }
}

// --- Physical boulders (shared environment) ----------------------------------------

/** 3-D value noise in [-1, 1] (render-side shape detail of the boulders). */
function noise3(x: number, y: number, z: number, seed: number): number {
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ Math.imul(seed, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const sm = (t: number) => t * t * (3 - 2 * t);
  const fx = sm(x - ix);
  const fy = sm(y - iy);
  const fz = sm(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const v = l(
    l(l(h(ix, iy, iz), h(ix + 1, iy, iz), fx), l(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), fx), fy),
    l(l(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), fx), l(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
  return v * 2 - 1;
}

/** Max visual deviation from the collider surface, as a fraction of (height + half width) / 2. */
export const BOULDER_NOISE = 0.12;
/** Of which: lumpy noise along the normal, and depth of the planar facets cut into the cap. */
const BOULDER_LUMP = 0.065;
const BOULDER_CUT = 0.055;

/**
 * Mesh of physical boulders that follows their colliders: each vertex of an
 * icosphere is mapped onto the cap of the rock's buried capsule (most
 * vertices on the visible cap, the rest folded just below the base so the
 * rock sits IN the seabed on slopes), then displaced along the normal by a
 * bounded noise and cut by a few shallow planar facets (fractured blocks),
 * together ≤ BOULDER_NOISE of the rock scale.
 */
export function buildBoulderGeometry(rocks: readonly Rock[], detail = 2): BufferGeometry {
  const base = mergeVertices(new IcosahedronGeometry(1, detail).deleteAttribute('normal').deleteAttribute('uv'));
  const bp = base.attributes.position as BufferAttribute;
  const bi = base.index!;
  const nv = bp.count;
  const pos = new Float32Array(rocks.length * nv * 3);
  const col = new Float32Array(rocks.length * nv * 3);
  const idx = new Uint32Array(rocks.length * bi.count);
  const T1 = 0.78 * Math.PI;
  const loc = new Float64Array(nv * 3);
  const vis = new Uint8Array(nv);
  rocks.forEach((rk, r) => {
    const c = rk.collider;
    const rho = c.radius;
    const L = Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z) / 2;
    const cx = (c.a.x + c.b.x) / 2;
    const cz = (c.a.z + c.b.z) / 2;
    const cy = c.a.y;
    const thCap = Math.acos(Math.max(-1, Math.min(1, (rho - rk.height) / rho)));
    const thBot = Math.acos(Math.max(-1, Math.min(1, (rho - rk.height - (0.2 * rk.height + 0.1)) / rho)));
    const cs = Math.cos(rk.yaw);
    const sn = Math.sin(rk.yaw);
    const scale = (rk.height + rk.halfWidth) / 2;
    const amp = BOULDER_LUMP * scale;
    const sd = Math.floor(rk.shape * 1e6);
    const g = rk.tint * 0.48;
    const warm = 0.95 + ((sd % 97) / 97) * 0.08;
    for (let v = 0; v < nv; v++) {
      const dx = bp.getX(v);
      const dy = bp.getY(v);
      const dz = bp.getZ(v);
      const th = Math.acos(Math.max(-1, Math.min(1, dy)));
      const hl = Math.hypot(dx, dz);
      const ux = hl > 1e-6 ? dx / hl : 1;
      const uz = hl > 1e-6 ? dz / hl : 0;
      const tp = th <= T1 ? (th / T1) * thCap : thCap + ((th - T1) / (Math.PI - T1)) * (thBot - thCap);
      const nx = Math.sin(tp) * ux;
      const ny = Math.cos(tp);
      const nz = Math.sin(tp) * uz;
      const seg = Math.max(-1, Math.min(1, nx * 4)) * L;
      // Bounded shape noise (two octaves, |n| ≤ 1), fading out below the base.
      const nn = 0.7 * noise3(dx * 1.6 + 3, dy * 1.6, dz * 1.6, sd) + 0.3 * noise3(dx * 4.1, dy * 4.1 + 7, dz * 4.1, sd + 1);
      vis[v] = tp <= thCap ? 1 : 0;
      const disp = rho + amp * nn * (vis[v] ? 1 : 0.4);
      loc[v * 3] = seg + nx * disp;
      loc[v * 3 + 1] = ny * disp;
      loc[v * 3 + 2] = nz * disp;
    }
    // Planar facets: a flattish top and three or four inclined fracture faces.
    const nCut = 4 + (sd % 2);
    for (let k = 0; k < nCut; k++) {
      const a = noise3(k * 3.1, 0.5, 0, sd + 9) * Math.PI * 2 + k * 1.7;
      const e = k === 0 ? 1.3 + 0.2 * noise3(1, k, 0, sd) : 0.25 + 0.45 * (0.5 + 0.5 * noise3(k, 2.2, 0, sd + 3));
      const px = Math.cos(e) * Math.cos(a);
      const py = Math.sin(e);
      const pz = Math.cos(e) * Math.sin(a);
      let m = -Infinity;
      for (let v = 0; v < nv; v++) if (vis[v]) m = Math.max(m, loc[v * 3] * px + loc[v * 3 + 1] * py + loc[v * 3 + 2] * pz);
      const d = m - BOULDER_CUT * scale;
      for (let v = 0; v < nv; v++) {
        const q = loc[v * 3] * px + loc[v * 3 + 1] * py + loc[v * 3 + 2] * pz - d;
        if (q > 0) {
          loc[v * 3] -= px * q;
          loc[v * 3 + 1] -= py * q;
          loc[v * 3 + 2] -= pz * q;
        }
      }
    }
    for (let v = 0; v < nv; v++) {
      const lx = loc[v * 3];
      const ly = loc[v * 3 + 1];
      const lz = loc[v * 3 + 2];
      const o = (r * nv + v) * 3;
      pos[o] = cx + lx * cs + lz * sn;
      pos[o + 1] = cy + ly;
      pos[o + 2] = cz - lx * sn + lz * cs;
      // Darker underside / base (shade and staining), slightly varied per rock.
      const shade = 0.72 + 0.28 * Math.min(1, Math.max(0, (ly - (rho - rk.height)) / Math.max(0.05, rk.height)));
      col[o] = g * warm * shade;
      col[o + 1] = g * 0.97 * shade;
      col[o + 2] = ((g * 0.9) / warm) * shade;
    }
    for (let k = 0; k < bi.count; k++) idx[r * bi.count + k] = r * nv + bi.getX(k);
  });
  base.dispose();
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// --- Build ------------------------------------------------------------------------------

export function createSeabed(quality: GraphicsQuality, options: SeabedOptions = {}): SeabedBuild {
  const env = options.environment ?? activeEnvironment();
  const H = env.terrainHeight;
  const seed = env.config.seed;
  const group = new Group();
  group.name = 'seabed';
  const cullables: Cullable[] = [];
  const b = SEABED_BOUNDS;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const disposables: { dispose(): void }[] = [];

  // --- Terrain: streamed tiles.
  const terrainMat = terrainMaterial(quality);
  disposables.push(terrainMat, terrainMat.map!, terrainMat.bumpMap!);
  const tiler = new TerrainTiler(env, terrainMat, group, cullables, { ...LOD_Q[quality], ...options.lod });
  tiler.update(options.focus ?? SITE_CENTER, true);

  const chunkKey = (x: number, z: number) => {
    const i = Math.max(0, Math.floor((x - b.minX) / ROCK_CHUNK));
    const j = Math.max(0, Math.floor((z - b.minZ) / ROCK_CHUNK));
    return j * 64 + i;
  };

  // --- Physical boulders: the environment's list, one merged mesh per chunk.
  const boulderMat = fouledMaterial(
    // Flat shading keeps the fracture planes crisp; the mesh is one detail level finer than
    // before so the facets read as rock texture, not as low-poly triangles. Darker
    // basalt-like albedo with a light sediment dusting on the upward faces only.
    { color: 0x4f4c46, roughness: 0.94, vertexColors: true, flatShading: quality !== 'low' },
    { amount: 0.4, sediment: 0.28, scale: 2.2, chips: 0, relief: 1, growth: new Color(0.17, 0.18, 0.14) },
  );
  disposables.push(boulderMat);
  const byChunk = new Map<number, Rock[]>();
  for (const rk of env.rocks) {
    const k = chunkKey(rk.x, rk.z);
    const list = byChunk.get(k);
    if (list) list.push(rk);
    else byChunk.set(k, [rk]);
  }
  for (const list of byChunk.values()) {
    const geo = buildBoulderGeometry(list, quality === 'low' ? 2 : quality === 'medium' ? 3 : 4);
    const mesh = new Mesh(geo, boulderMat);
    mesh.name = 'boulders';
    mesh.castShadow = false; // see rocks below: lamp shadow passes would redraw whole chunks
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    cullables.push({ object: mesh, box: geo.boundingBox!.clone().expandByScalar(0.3) });
    disposables.push(geo);
  }

  // --- Cosmetic stones (< 0.3 m) + berm stones, instanced per chunk ----------------------
  const r = rng(1337 + seed * 7919);
  const rockGeo = new IcosahedronGeometry(1, quality === 'high' ? 2 : 1);
  const { mat: rockMat, depth: rockDepth } = rockMaterials();
  disposables.push(rockGeo, rockMat, rockDepth);
  const chunks = new Map<number, { m: Matrix4; c: Color }[]>();
  const pushStone = (x: number, z: number, m: Matrix4, c: Color) => {
    const k = chunkKey(x, z);
    const list = chunks.get(k);
    if (list) list.push({ m, c });
    else chunks.set(k, [{ m, c }]);
  };
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const tmpCols: Collider[] = [];
  /** True when (x, z) lies on a physical rock / the berm (cosmetic detail would intersect it). */
  const onRock = (x: number, z: number, margin: number) => {
    tmpCols.length = 0;
    env.queryColliders(x - margin, z - margin, x + margin, z + margin, tmpCols);
    if (!tmpCols.length) return false;
    return env.surfaceHeight(x, z) > H(x, z) + 0.01 || tmpCols.some((c) => c.kind === 'capsule' && Math.hypot(x - (c.a.x + c.b.x) / 2, z - (c.a.z + c.b.z) / 2) < margin);
  };
  const addStone = (x: number, z: number, size: number, bury: number, tint: number) => {
    p.set(x, H(x, z) + size * (0.12 - bury), z);
    q.setFromAxisAngle(new Vector3(r() - 0.5, 1.5, r() - 0.5).normalize(), r() * Math.PI * 2);
    s.set(size * (0.8 + r() * 0.6), size * (0.6 + r() * 0.5), size * (0.8 + r() * 0.6));
    const g = tint * (0.8 + r() * 0.3);
    const warm = 0.94 + r() * 0.08;
    pushStone(x, z, new Matrix4().compose(p.clone(), q.clone(), s.clone()), new Color(g * warm, g * 0.97, (g * 0.9) / warm));
  };
  // Cobbles and pebbles: rubble around the boulders and gravel patches. Cosmetic: < 0.3 m.
  const nCob = COBBLES[quality];
  const big = env.rocks.filter((k) => k.size > 0.45);
  for (let i = 0, tries = 0; i < nCob && tries < nCob * 6; tries++) {
    let x: number;
    let z: number;
    if (big.length && r() < 0.55) {
      const rk = big[Math.floor(r() * big.length)];
      const a = r() * Math.PI * 2;
      const rr = rk.halfLength + 0.2 + Math.pow(r(), 1.5) * 3;
      x = rk.x + Math.cos(a) * rr;
      z = rk.z + Math.sin(a) * rr;
    } else {
      x = b.minX + r() * w;
      z = b.minZ + r() * d;
      if (r() > 0.1 + sedimentAt(x, z, seed).gravel * 2.5) continue;
    }
    const size = 0.04 + Math.pow(r(), 2.2) * 0.22;
    if (rockExcluded(x, z, size) || onRock(x, z, size + 0.1)) continue;
    addStone(x, z, size, r() * 0.3, 0.95);
    i++;
  }
  // Rock berm stones (physical berm: the environment's list, same for every quality).
  for (const st of env.bermStones) {
    p.set(st.x, st.y, st.z);
    q.setFromAxisAngle(new Vector3(Math.sin(st.yaw * 3) * 0.5, 1, Math.cos(st.yaw * 5) * 0.5).normalize(), st.yaw);
    s.set(st.sx, st.sy, st.sz);
    pushStone(st.x, st.z, new Matrix4().compose(p.clone(), q.clone(), s.clone()), new Color(st.tint * 0.72, st.tint * 0.72, st.tint * 0.76));
  }
  for (const list of chunks.values()) {
    const rocks = new InstancedMesh(rockGeo, rockMat, list.length);
    list.forEach((it, k) => {
      rocks.setMatrixAt(k, it.m);
      rocks.setColorAt(k, it.c);
    });
    rocks.computeBoundingBox();
    rocks.computeBoundingSphere();
    // Rocks receive but do not cast lamp shadows: each chunk inside a lamp
    // frustum would be re-rendered whole in every shadow pass.
    rocks.castShadow = false;
    rocks.receiveShadow = true;
    rocks.customDepthMaterial = rockDepth; // used if casting is re-enabled
    rocks.name = 'rocks';
    group.add(rocks);
    cullables.push({ object: rocks, box: rocks.boundingBox!.clone().expandByScalar(0.5) });
    disposables.push({ dispose: () => rocks.dispose() });
  }

  // --- Sessile life: sponges / soft corals (small cones), on and around hard substrate.
  const lifeGeo = new ConeGeometry(0.12, 0.5, 6, 1, false);
  lifeGeo.translate(0, 0.25, 0);
  const lifeMat = new MeshStandardMaterial({ roughness: 0.8, color: 0xffffff });
  disposables.push(lifeGeo, lifeMat);
  const nLife = LIFE[quality];
  const life = new InstancedMesh(lifeGeo, lifeMat, nLife);
  const palette = [new Color(0.85, 0.55, 0.35), new Color(0.9, 0.82, 0.62), new Color(0.75, 0.32, 0.3), new Color(0.88, 0.88, 0.8)];
  const up = new Vector3(0, 1, 0);
  const m = new Matrix4();
  const normalAt = (x: number, z: number): [number, number, number] => {
    const e = 0.5;
    const hx = H(x + e, z) - H(x - e, z);
    const hz = H(x, z + e) - H(x, z - e);
    const l = Math.hypot(hx, 2 * e, hz);
    return [-hx / l, (2 * e) / l, -hz / l];
  };
  for (let i = 0; i < nLife; i++) {
    let x = b.minX + r() * w;
    let z = b.minZ + r() * d;
    let y: number;
    let n = normalAt(x, z);
    if (env.rocks.length && r() < 0.35) {
      // On a boulder's upper surface (attached fauna prefers hard substrate).
      const rk = env.rocks[Math.floor(r() * env.rocks.length)];
      const a = r() * Math.PI * 2;
      const rr = Math.sqrt(r()) * rk.halfWidth * 0.6;
      x = rk.x + Math.cos(a) * rr;
      z = rk.z + Math.sin(a) * rr;
      y = env.surfaceHeight(x, z) - 0.03;
      n = [0, 1, 0];
    } else {
      y = H(x, z) - 0.03;
      if (onRock(x, z, 0.2)) y = env.surfaceHeight(x, z) - 0.03;
    }
    q.setFromUnitVectors(up, new Vector3(n[0] + (r() - 0.5) * 0.4, n[1], n[2] + (r() - 0.5) * 0.4).normalize());
    const sc = 0.4 + r() * 1.2;
    s.set(sc * (0.7 + r() * 0.6), sc, sc * (0.7 + r() * 0.6));
    p.set(x, y, z);
    m.compose(p, q, s);
    life.setMatrixAt(i, m);
    life.setColorAt(i, palette[Math.floor(r() * palette.length)]);
  }
  life.instanceMatrix.setUsage(DynamicDrawUsage);
  life.castShadow = quality === 'high';
  life.receiveShadow = true;
  group.add(life);
  disposables.push({ dispose: () => life.dispose() });

  // --- Shells around the site (scale cue at 1–3 m), merged with the debris below.
  const nShell = SHELLS[quality];
  const shellGeo = new SphereGeometry(1, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
  const shellCols = [new Color(0.74, 0.7, 0.62), new Color(0.68, 0.56, 0.48), new Color(0.6, 0.56, 0.52), new Color(0.78, 0.76, 0.72)];
  const shells: { geo: BufferGeometry; color: Color; m: Matrix4 }[] = [];
  for (let i = 0; i < nShell; i++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * 48;
    const x = SITE_CENTER.x + Math.cos(a) * rad;
    const z = SITE_CENTER.z + Math.sin(a) * rad;
    const sc = 0.02 + r() * 0.035;
    const n = normalAt(x, z);
    q.setFromUnitVectors(up, new Vector3(n[0] + (r() - 0.5) * 0.6, 1, n[2] + (r() - 0.5) * 0.6).normalize());
    if (r() < 0.4) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI)); // upside down
    p.set(x, H(x, z) + 0.004, z);
    s.set(sc, sc * 0.35, sc * 0.9);
    shells.push({ geo: shellGeo, color: shellCols[Math.floor(r() * shellCols.length)], m: new Matrix4().compose(p, q, s) });
  }

  // --- Dropped objects / debris: scale cues near the site.
  const debris = createDebris(quality, shells, H);
  group.add(debris);
  debris.geometry.computeBoundingBox();
  cullables.push({ object: debris, box: debris.geometry.boundingBox!.clone() });
  disposables.push(debris.geometry, debris.material as Material, shellGeo);

  return {
    group,
    cullables,
    environment: env,
    stats: tiler.stats,
    update: (focus) => tiler.update(focus),
    dispose: () => {
      tiler.dispose();
      for (const x of disposables) x.dispose();
      group.clear();
    },
  };
}

/** Structure footprints (mudmats) for scour / sediment shading: centre xz, half size, yaw. */
function footprints(): { f: Vector4[]; r: Vector2[] } {
  const f: Vector4[] = [];
  const r: Vector2[] = [];
  const add = (x: number, z: number, hx: number, hz: number, yaw: number) => {
    f.push(new Vector4(x, z, hx, hz));
    r.push(new Vector2(Math.cos(yaw), Math.sin(yaw)));
  };
  add(MANIFOLD.position.x, MANIFOLD.position.z, MANIFOLD.size.x / 2 + 0.3, MANIFOLD.size.z / 2 + 0.3, MANIFOLD.yaw);
  add(TREE.position.x, TREE.position.z, TREE.size.x / 2 + 0.3, TREE.size.z / 2 + 0.3, TREE.yaw);
  add(PLET.position.x, PLET.position.z, PLET.size.x / 2 + 0.2, PLET.size.z / 2 + 0.2, 0);
  return { f, r };
}

/** Seabed scars (anchor drag / old plough trench) as segments in the xz plane. */
const SCARS = [
  [-34, -12, -22, -175],
  [52, 10, 150, -150],
];

/**
 * Terrain material: world-space sand texture at two scales (no visible
 * tiling), sediment-driven look from the shared sedimentAt() field (vertex
 * attribute aSed = mud, sand, gravel): mud darker, smoother and flatter in
 * texture, with more burrows; sand lighter with current ripples; gravel with
 * pebble speckle. Plus scour/sediment around the structures, drill cuttings
 * around the well and seabed scars. Sub-metre relief is applied to the normal
 * only (the shared height field used by physics carries everything >= ~1 m),
 * faded with distance so it never aliases.
 */
function terrainMaterial(quality: GraphicsQuality): MeshStandardMaterial {
  const { map, bump } = makeSandTextures(quality === 'low' ? 256 : 512);
  const mat = new MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 0.6,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  });
  const fp = footprints();
  const detail = quality === 'low' ? 0 : 1;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFoot = { value: fp.f };
    shader.uniforms.uFootRot = { value: fp.r };
    shader.uniforms.uWell = { value: new Vector2(TREE.position.x, TREE.position.z) };
    shader.uniforms.uSite = { value: new Vector2(SITE_CENTER.x, SITE_CENTER.z) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nattribute vec3 aSed;\nvarying vec3 vSed;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSed = aSed;');
    const scars = SCARS.map((s) => `vec4(${s.map((v) => v.toFixed(1)).join(', ')})`).join(', ');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        #define SEABED_DETAIL ${detail}
        varying vec3 vWPos;
        varying vec3 vSed;
        uniform vec4 uFoot[3];
        uniform vec2 uFootRot[3];
        uniform vec2 uWell;
        uniform vec2 uSite;
        ${NOISE_GLSL}
        ${PERTURB_GLSL}
        float boxSd(vec2 p, vec4 f, vec2 cs) {
          vec2 d = p - f.xy;
          d = vec2(d.x * cs.x - d.y * cs.y, d.x * cs.y + d.y * cs.x);
          vec2 q = abs(d) - f.zw;
          return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        }
        float segD(vec2 p, vec2 a, vec2 b) {
          vec2 pa = p - a, ba = b - a;
          float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
          return length(pa - ba * h);
        }
        // Seabed features shared by colour and relief.
        float sbScour = 0.0;   // 0..1 fine silt band around structures
        float sbCuttings = 0.0;
        float sbScar = 0.0;
        float sbHeight = 0.0;
        float sbPebble = 0.0;
        void seabedFeatures(vec2 p) {
          float sd = 1e3;
          for (int i = 0; i < 3; i++) sd = min(sd, boxSd(p, uFoot[i], uFootRot[i]));
          float n = wNoise(vec3(p * 0.9, 2.0));
          sbScour = (1.0 - smoothstep(0.0, 2.2 + n * 1.2, sd)) * step(-0.2, sd);
          // Scour moat at the mudmat edge and a low berm of deposited fines.
          sbHeight += -0.10 * exp(-max(sd, 0.0) / 0.45) * step(-0.05, sd) + 0.035 * exp(-pow((sd - 1.3) / 0.5, 2.0));
          // Drill cuttings around the well: pale grey, lumpy.
          float dw = length(p - uWell);
          sbCuttings = (1.0 - smoothstep(3.0, 8.5 + n * 2.5, dw)) * step(1.5, sd);
          sbHeight += sbCuttings * (wNoise(vec3(p * 1.6, 9.0)) - 0.5) * 0.08;
          // Scars: groove with low berms either side.
          ${'const vec4 SCARS[2] = vec4[2](' + scars + ');'}
          for (int i = 0; i < 2; i++) {
            float d = segD(p, SCARS[i].xy, SCARS[i].zw) + (wNoise(vec3(p * 0.3, float(i))) - 0.5) * 0.6;
            float g = exp(-pow(d / 0.35, 2.0));
            sbScar = max(sbScar, g);
            sbHeight += -0.08 * g + 0.035 * exp(-pow((d - 0.65) / 0.25, 2.0));
          }
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `
        seabedFeatures(vWPos.xz);
        #ifdef USE_MAP
          vec4 s1 = texture2D(map, vWPos.xz / 5.0);
          vec4 s2 = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * vWPos.xz / 13.0 + 0.37);
          float mixN = wNoise(vec3(vWPos.xz * 0.08, 1.7));
          vec4 tex = mix(s1, s2, smoothstep(0.3, 0.7, mixN));
          // Mud: fine, homogeneous - the grain / shell-fragment contrast of the sand texture fades out.
          vec4 texAvg = texture2D(map, vWPos.xz / 5.0, 6.0);
          diffuseColor *= mix(tex, texAvg, vSed.x * 0.6);
        #endif
        {
          // Gravel: scattered pebbles (darker and paler), anti-aliased out with distance.
          vec2 gc = vWPos.xz * 7.0;
          vec2 gi = floor(gc);
          vec2 gf = fract(gc) - 0.5 + (vec2(wHash(vec3(gi, 5.0)), wHash(vec3(gi, 6.0))) - 0.5) * 0.3;
          float paa = clamp(1.6 - length(fwidth(gc)) * 1.4, 0.0, 1.0);
          sbPebble = step(1.0 - clamp(vSed.z * 1.4 - 0.02, 0.0, 0.85), wHash(vec3(gi, 3.0)))
            * smoothstep(0.36, 0.22, length(gf)) * paa * (1.0 - sbScour);
          diffuseColor.rgb *= mix(1.0, 0.55 + 0.75 * wHash(vec3(gi, 8.0)), sbPebble);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.77, 0.74), sbScour * 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.62, 0.60) * (0.85 + 0.3 * wNoise(vec3(vWPos.xz * 3.0, 4.0))), sbCuttings * 0.75);
        diffuseColor.rgb *= 1.0 - sbScar * 0.18;
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          float camD = length(vWPos - cameraPosition);
          float fade = 1.0 - smoothstep(5.0, 32.0, camD);
          float H = sbHeight;
          #if SEABED_DETAIL > 0
          if (fade > 0.0) {
            // Current ripples: crest direction wanders slowly, asymmetric profile.
            vec2 dir = normalize(vec2(0.93, 0.36) + (wNoise(vec3(p * 0.04, 7.0)) - 0.5) * 0.9);
            float ph = dot(p, dir) * 6.2831 / 0.42 + wNoise(vec3(p * 0.3, 3.1)) * 7.0 + wNoise(vec3(p * 1.1, 4.7)) * 2.0;
            float aa = clamp(1.4 - fwidth(ph) * 0.6, 0.0, 1.0);
            float rip = (sin(ph) + 0.3 * sin(2.0 * ph + 1.2)) * aa;
            // Ripples only where the bed is sandy (mud is cohesive, gravel too coarse).
            float field = smoothstep(0.2, 0.6, vSed.y) * smoothstep(0.25, 0.65, wNoise(vec3(p * 0.05, 11.0))) * 0.7;
            field *= (1.0 - sbScour) * (1.0 - sbCuttings) * (1.0 - sbScar);
            H += rip * 0.011 * field * fade;
            // Lumps, bioturbation mounds and burrow holes.
            H += (wNoise(vec3(p * 2.3, 5.0)) - 0.5) * (0.02 + 0.015 * vSed.x) * fade;
            float cell = wHash(vec3(floor(p * 1.3), 1.0));
            vec2 f = fract(p * 1.3) - 0.5;
            // Burrows and their spoil mounds: commoner in mud.
            H += step(0.975 - 0.025 * vSed.x, cell) * (-0.02 * exp(-dot(f, f) * 160.0) + 0.01 * exp(-dot(f, f) * 30.0)) * fade;
            H += sbPebble * 0.01 * fade;
            float gaa = clamp(1.5 - fwidth(p.x * 11.0), 0.0, 1.0);
            H += (wNoise(vec3(p * 11.0, 0.0)) - 0.5) * 0.004 * gaa * fade;
          }
          #endif
          normal = surfPerturb(-vViewPosition, normal, vec2(dFdx(H), dFdy(H)), faceDirection);
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        // Wet mud reads smoother (faint sheen under the lamps), sand matte, gravel in between.
        roughnessFactor = dot(vSed, vec3(0.84, 0.97, 0.92)) * (1.0 - 0.06 * sbPebble);`,
      );
  };
  mat.customProgramCacheKey = () => `seabed-v4-${detail}`;
  return mat;
}

/**
 * Boulder material: one base geometry, every instance reshaped in the vertex
 * shader by noise keyed to its position (no two rocks alike), flat shaded,
 * with growth and silt on top. A matching depth material keeps the shadows.
 */
function rockMaterials(): { mat: MeshStandardMaterial; depth: MeshDepthMaterial } {
  // Shape function of a unit rock (seeded by the instance position) and its
  // smooth normal by finite differences, so a low-poly base reads as a rounded,
  // irregular boulder or slab.
  const shapeGlsl = /* glsl */ `
    vec3 rockSeed() {
      #ifdef USE_INSTANCING
        return instanceMatrix[3].xyz;
      #else
        return vec3(0.0);
      #endif
    }
    vec3 rockShape(vec3 p, vec3 seed) {
      float n1 = wNoise(p * 1.3 + seed * 0.37);
      float n2 = wNoise(p * 3.7 + seed * 0.11);
      float slab = step(0.6, fract(seed.x * 0.173 + seed.z * 0.311));
      float n3 = wNoise(p * 7.9 - seed * 0.23);
      vec3 q = p * (0.7 + 0.45 * n1 + 0.22 * n2 + 0.07 * n3);
      q.y *= mix(0.75, 0.42, slab);
      q.y = max(q.y, -0.3 + 0.05 * n2);
      return q;
    }`;
  const normalGlsl = /* glsl */ `
    {
      vec3 rs = rockSeed();
      vec3 pn = normalize(position);
      vec3 t1 = normalize(cross(pn, abs(pn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 t2 = cross(pn, t1);
      vec3 c0 = rockShape(position, rs);
      vec3 c1 = rockShape(position + t1 * 0.08, rs) - c0;
      vec3 c2 = rockShape(position + t2 * 0.08, rs) - c0;
      vec3 rn = normalize(cross(c1, c2));
      objectNormal = dot(rn, pn) < 0.0 ? -rn : rn;
    }`;
  const mat = fouledMaterial(
    { color: 0x7a766b, roughness: 0.95 },
    { amount: 0.35, sediment: 0.85, scale: 2.2, chips: 0, relief: 1, growth: new Color(0.3, 0.3, 0.22) },
  );
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${shapeGlsl}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${normalGlsl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed = rockShape(position, rockSeed());`);
  };
  mat.customProgramCacheKey = () => 'rock-v3';
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${shapeGlsl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed = rockShape(position, rockSeed());`);
  };
  depth.customProgramCacheKey = () => 'rock-depth-v3';
  return { mat, depth };
}

/** Old anchor chain, a drum, a scaffold tube, a fender tyre and a beam offcut. */
function createDebris(quality: GraphicsQuality, extra: { geo: BufferGeometry; color: Color; m: Matrix4 }[], H: (x: number, z: number) => number): Mesh {
  const parts: BufferGeometry[] = [];
  const put = (geo: BufferGeometry, color: Color, m: Matrix4) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new BufferAttribute(c, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    parts.push(g);
  };
  const ground = H;
  const rust = new Color(0.17, 0.13, 0.1);
  // Anchor chain (~11 m of 76 mm studless chain) lying in a lazy S.
  const seg = quality === 'low' ? 6 : 9;
  const link = new TorusGeometry(0.1, 0.034, 5, seg);
  link.scale(1.55, 1, 1);
  const start = new Vector3(11, 0, -66);
  const pitch = 0.27;
  const nLinks = 42;
  let heading = 0.35;
  const pos = start.clone();
  for (let i = 0; i < nLinks; i++) {
    heading += Math.sin(i * 0.18) * 0.06;
    const dir = new Vector3(Math.cos(heading), 0, Math.sin(heading));
    pos.addScaledVector(dir, pitch);
    const flat = i % 2 === 0;
    const y = ground(pos.x, pos.z) + (flat ? 0.02 : 0.085) - (i > 30 ? (i - 30) * 0.01 : 0);
    const qd = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), dir);
    const qr = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), flat ? Math.PI / 2 : 0);
    put(link.clone(), rust, new Matrix4().compose(new Vector3(pos.x, y, pos.z), qd.multiply(qr), new Vector3(1, 1, 1)));
  }
  // Crushed 200 l drum on its side, half buried.
  const drum = new CylinderGeometry(0.29, 0.29, 0.88, 14, 1);
  const dp = drum.attributes.position as BufferAttribute;
  for (let i = 0; i < dp.count; i++) {
    const x = dp.getX(i);
    const z = dp.getZ(i);
    if (x > 0.1) dp.setX(i, x * 0.7);
    dp.setZ(i, z * (1 + 0.08 * Math.sin(dp.getY(i) * 9)));
  }
  drum.computeVertexNormals();
  put(drum, new Color(0.2, 0.3, 0.42), new Matrix4().compose(new Vector3(40, ground(40, -94) + 0.17, -94), new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0.6, 0.2)), new Vector3(1, 1, 1)));
  // Scaffold tube with a coupler.
  const tubeQ = new Quaternion().setFromEuler(new Euler(0, 0.9, Math.PI / 2));
  put(new CylinderGeometry(0.024, 0.024, 4, 8), new Color(0.55, 0.56, 0.55), new Matrix4().compose(new Vector3(-3, ground(-3, -84) + 0.03, -84), tubeQ, new Vector3(1, 1, 1)));
  put(new BoxGeometry(0.09, 0.09, 0.12), new Color(0.5, 0.5, 0.48), new Matrix4().compose(new Vector3(-3.6, ground(-3.6, -84.8) + 0.05, -84.8), tubeQ, new Vector3(1, 1, 1)));
  // Fender tyre lying flat.
  put(new TorusGeometry(0.42, 0.15, 8, 18), new Color(0.07, 0.07, 0.07), new Matrix4().compose(new Vector3(18, ground(18, -103) + 0.1, -103), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 + 0.08), new Vector3(1, 1, 1)));
  // I-beam offcut resting at an angle.
  const ib = new Matrix4().compose(new Vector3(46, ground(46, -69) + 0.12, -69), new Quaternion().setFromEuler(new Euler(0.12, 0.4, 0.05)), new Vector3(1, 1, 1));
  put(new BoxGeometry(2.2, 0.02, 0.2), rust, new Matrix4().makeTranslation(0, 0.1, 0).premultiply(ib));
  put(new BoxGeometry(2.2, 0.02, 0.2), rust, new Matrix4().makeTranslation(0, -0.1, 0).premultiply(ib));
  put(new BoxGeometry(2.2, 0.2, 0.015), rust, ib.clone());
  for (const e of extra) put(e.geo.clone(), e.color, e.m);
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  const mat: Material = fouledMaterial(
    { vertexColors: true, roughness: 0.75, metalness: 0.3 },
    { amount: 0.5, sediment: 0.8, chips: 0.4, scale: 3, relief: 1 },
  );
  const mesh = new Mesh(merged, mat);
  mesh.name = 'debris';
  mesh.castShadow = false; // small, low objects: not worth a shadow-pass draw
  mesh.receiveShadow = true;
  return mesh;
}
