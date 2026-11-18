import { describe, expect, it } from 'vitest';
import { Group, MeshBasicMaterial, type BufferAttribute, type BufferGeometry } from 'three';
import { getEnvironment } from '../src/sim/environment';
import { SITE_CENTER } from '../src/sim/terrain';
import { MANIFOLD, TREE } from '../src/sim/site';
import { SEABED_BOUNDS, TILE_SIZE, TerrainTiler, buildTerrainTile, skirtDepth, type Cullable } from '../src/render/seabed';

const env = getEnvironment();
const H = env.terrainHeight;

/** Top-surface vertices (no skirt) of a tile geometry built with `segs` segments. */
function grid(geo: BufferGeometry, segs: number) {
  const pos = geo.attributes.position as BufferAttribute;
  const nrm = geo.attributes.normal as BufferAttribute;
  const n = segs + 1;
  return {
    y: (i: number, j: number) => pos.getY(j * n + i),
    x: (i: number, j: number) => pos.getX(j * n + i),
    z: (i: number, j: number) => pos.getZ(j * n + i),
    n: (i: number, j: number) => [nrm.getX(j * n + i), nrm.getY(j * n + i), nrm.getZ(j * n + i)],
  };
}

describe('terrain tiles', () => {
  it('render heights are the physics heights at every vertex', () => {
    const x0 = SEABED_BOUNDS.minX + 5 * TILE_SIZE;
    const z0 = SEABED_BOUNDS.minZ + 6 * TILE_SIZE;
    const g = grid(buildTerrainTile(H, 0, x0, z0, TILE_SIZE, 32), 32);
    for (let j = 0; j <= 32; j += 3) for (let i = 0; i <= 32; i += 3) expect(g.y(i, j)).toBeCloseTo(H(g.x(i, j), g.z(i, j)), 4);
  });

  it('shared edges of neighbouring tiles are identical (same LOD: heights and normals)', () => {
    const x0 = SEABED_BOUNDS.minX + 6 * TILE_SIZE;
    const z0 = SEABED_BOUNDS.minZ + 4 * TILE_SIZE;
    for (const segs of [32, 16, 8, 4]) {
      const a = grid(buildTerrainTile(H, 0, x0, z0, TILE_SIZE, segs), segs);
      const east = grid(buildTerrainTile(H, 0, x0 + TILE_SIZE, z0, TILE_SIZE, segs), segs);
      const south = grid(buildTerrainTile(H, 0, x0, z0 + TILE_SIZE, TILE_SIZE, segs), segs);
      for (let k = 0; k <= segs; k++) {
        expect(east.x(0, k)).toBe(a.x(segs, k));
        expect(east.y(0, k)).toBe(a.y(segs, k));
        expect(east.n(0, k)).toEqual(a.n(segs, k));
        expect(south.z(k, 0)).toBe(a.z(k, segs));
        expect(south.y(k, 0)).toBe(a.y(k, segs));
        expect(south.n(k, 0)).toEqual(a.n(k, segs));
      }
    }
  });

  it('LOD transitions: coarse edge vertices coincide with fine ones; the gap is covered by the skirt', () => {
    let worst = 0;
    for (let ti = 0; ti < 11; ti += 2) {
      for (let tj = 0; tj < 10; tj += 3) {
        const x0 = SEABED_BOUNDS.minX + ti * TILE_SIZE;
        const z0 = SEABED_BOUNDS.minZ + tj * TILE_SIZE;
        for (const [fine, coarse] of [[32, 16], [16, 8], [8, 4]]) {
          const f = grid(buildTerrainTile(H, 0, x0, z0, TILE_SIZE, fine), fine);
          const c = grid(buildTerrainTile(H, 0, x0 + TILE_SIZE, z0, TILE_SIZE, coarse), coarse);
          const r = fine / coarse;
          const skirt = skirtDepth(TILE_SIZE / coarse);
          for (let k = 0; k <= fine; k++) {
            const kc = Math.floor(k / r);
            const t = (k - kc * r) / r;
            const yc = t === 0 ? c.y(0, kc) : c.y(0, kc) * (1 - t) + c.y(0, kc + 1) * t;
            if (t === 0) expect(f.y(fine, k)).toBe(c.y(0, kc));
            const gap = Math.abs(f.y(fine, k) - yc);
            worst = Math.max(worst, gap / skirt);
            expect(gap).toBeLessThan(skirt);
          }
        }
      }
    }
    console.log(`LOD seam: worst gap = ${(worst * 100).toFixed(0)} % of the skirt depth`);
  });

  it('streams around a moving focus: centre always loaded, far tiles disposed, bounded work per update', () => {
    const group = new Group();
    const cullables: Cullable[] = [];
    const tiler = new TerrainTiler(env, new MeshBasicMaterial(), group, cullables, { segments0: 32, radii: [64, 120, 200], maxTilesPerUpdate: 2 });
    const disposed = new Set<BufferGeometry>();
    const watch = () => tiler.tiles.forEach((t) => t.mesh.geometry.addEventListener('dispose', (e) => disposed.add(e.target as BufferGeometry)));
    tiler.update(SITE_CENTER, true);
    watch();
    const centreKeys = [MANIFOLD.position, TREE.position].map((p) => {
      const i = Math.floor((p.x - SEABED_BOUNDS.minX) / TILE_SIZE);
      const j = Math.floor((p.z - SEABED_BOUNDS.minZ) / TILE_SIZE);
      return j * tiler.nx + i;
    });
    expect(tiler.stats.pending).toBe(0);
    for (const k of centreKeys) expect(tiler.tiles.get(k)?.lod).toBe(0);
    const initial = tiler.tiles.size;
    expect(cullables.length).toBe(initial);
    expect(group.children.length).toBe(initial);

    // Fly to the far south-west corner and back, one update per "frame" (0.5 m per frame).
    const far = { x: SEABED_BOUNDS.minX + 10, z: SEABED_BOUNDS.minZ + 10 };
    const path: { x: number; z: number }[] = [];
    const legs = [
      [SITE_CENTER, far],
      [far, SITE_CENTER],
    ] as const;
    for (const [a, b] of legs) {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5);
      for (let s = 1; s <= n; s++) path.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
    }
    let maxBuilt = 0;
    let atFarUnloaded = 0;
    let lastGen = tiler.stats.generated;
    path.forEach((f, step) => {
      tiler.update(f);
      watch();
      maxBuilt = Math.max(maxBuilt, tiler.stats.generated - lastGen);
      lastGen = tiler.stats.generated;
      // The operating area never unloads.
      for (const k of centreKeys) expect(tiler.tiles.has(k)).toBe(true);
      // The cullable list mirrors the loaded tiles.
      expect(cullables.length).toBe(tiler.tiles.size);
      if (step === Math.floor(path.length / 2) - 1) atFarUnloaded = disposed.size;
    });
    expect(maxBuilt).toBeLessThanOrEqual(2);
    // At the far corner, tiles more than unloadDistance away were disposed (north-east of the map).
    expect(atFarUnloaded).toBeGreaterThan(10);
    // Near the far focus the terrain reached full resolution.
    for (let i = 0; i < 400; i++) tiler.update(far);
    const fi = Math.floor((far.x - SEABED_BOUNDS.minX) / TILE_SIZE);
    const fj = Math.floor((far.z - SEABED_BOUNDS.minZ) / TILE_SIZE);
    expect(tiler.tiles.get(fj * tiler.nx + fi)?.lod).toBe(0);
    const ne = tiler.tiles.get((tiler.nz - 1) * tiler.nx + (tiler.nx - 1));
    expect(ne).toBeUndefined();
    // Disposed geometries are no longer in the scene.
    group.traverse((o) => {
      const g = (o as unknown as { geometry?: BufferGeometry }).geometry;
      if (g) expect(disposed.has(g)).toBe(false);
    });
    console.log(
      `terrain tiles: ${tiler.stats.generated} built, mean ${tiler.stats.meanTileMs.toFixed(2)} ms, max ${tiler.stats.maxTileMs.toFixed(2)} ms; loaded ${tiler.tiles.size}, ${tiler.stats.vertices} vertices`,
    );
    expect(tiler.stats.meanTileMs).toBeLessThan(15);
    tiler.dispose();
    expect(cullables.length).toBe(0);
    expect(group.children.length).toBe(0);
  });

  it('LOD selection has hysteresis (no rebuild ping-pong at a radius)', () => {
    const tiler = new TerrainTiler(env, new MeshBasicMaterial(), new Group(), [], { radii: [64, 120, 200], hysteresis: 8 });
    // A focus moving back and forth 2 m across the LOD-0 radius of a tile.
    const i = 8;
    const j = 6;
    const { x0, z0 } = tiler.tileOrigin(i, j);
    const at = (d: number) => ({ x: x0 - d, z: z0 + TILE_SIZE / 2 });
    expect(tiler.wantedLod(i, j, at(63))).toBe(0);
    expect(tiler.wantedLod(i, j, at(65), 0)).toBe(0); // stays fine within the hysteresis
    expect(tiler.wantedLod(i, j, at(73), 0)).toBe(1);
    expect(tiler.wantedLod(i, j, at(65), 1)).toBe(1);
  });
});
