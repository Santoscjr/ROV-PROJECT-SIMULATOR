import { describe, expect, it } from 'vitest';
import { Mesh, Vector3, type BufferAttribute } from 'three';
import {
  ColliderGrid,
  ROCK_PHYSICAL_MIN_SIZE,
  WORLD_BOUNDS,
  getEnvironment,
  rockExcluded,
  type Rock,
} from '../src/sim/environment';
import { COLLIDERS, CONTEXT_STRUCTURES, INSPECTION_POINTS, PIPELINE_PATH, type Collider } from '../src/sim/site';
import { MISSIONS, adverseTasks, trainingTasks } from '../src/mission/catalog';
import { colliderBounds, sphereCollider } from '../src/physics/collision';
import { BOULDER_NOISE, buildBoulderGeometry, createSeabed } from '../src/render/seabed';
import { CONTEXT_LAYOUT } from '../src/render/context';

/** Minimal DOM stub so the renderer's canvas textures can be built in node. */
function withDocument<T>(f: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const prev = g.document;
  const ctx = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => undefined,
  };
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  try {
    return f();
  } finally {
    g.document = prev;
  }
}

/** Distance from a point to a capsule's surface (negative inside). */
function capsuleSurfaceDistance(p: Vector3, c: Extract<Collider, { kind: 'capsule' }>): number {
  const ab = new Vector3(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
  const ap = new Vector3(p.x - c.a.x, p.y - c.a.y, p.z - c.a.z);
  const l2 = ab.lengthSq();
  const t = l2 > 0 ? Math.max(0, Math.min(1, ap.dot(ab) / l2)) : 0;
  return ap.sub(ab.multiplyScalar(t)).length() - c.radius;
}

describe('environment: deterministic physical rock field', () => {
  it('same seed → identical rocks / berm; different seed → different rocks', () => {
    const a = getEnvironment({ seed: 3 });
    const a2 = getEnvironment({ seed: 3 });
    expect(a2).toBe(a); // memoised
    // Regenerate through a different cache key path: seed 3.0 is the same seed.
    expect(getEnvironment({ seed: 3.0 }).rocks).toBe(a.rocks);
    const b = getEnvironment({ seed: 4 });
    const sig = (rs: readonly Rock[]) => rs.map((r) => `${r.x.toFixed(4)},${r.z.toFixed(4)},${r.size.toFixed(4)}`).join(';');
    expect(sig(b.rocks)).not.toBe(sig(a.rocks));
    // Default environment is seed 0 and stable across calls.
    expect(getEnvironment().config.seed).toBe(0);
    expect(sig(getEnvironment().rocks)).toBe(sig(getEnvironment({ seed: 0 }).rocks));
  });

  it('only rocks ≥ 0.3 m, a few hundred, clear of infrastructure and mission points', () => {
    const env = getEnvironment();
    expect(env.rocks.length).toBeGreaterThan(150);
    expect(env.physicalColliders.length).toBeLessThan(450);
    for (const r of env.rocks) {
      expect(r.size).toBeGreaterThanOrEqual(ROCK_PHYSICAL_MIN_SIZE);
      expect(r.height).toBeGreaterThan(0.15);
      expect(rockExcluded(r.x, r.z, r.halfLength)).toBe(false);
      expect(r.x - r.halfLength).toBeGreaterThanOrEqual(WORLD_BOUNDS.minX);
      expect(r.z + r.halfLength).toBeLessThanOrEqual(WORLD_BOUNDS.maxZ);
      // The collider's top is the rock top, its base footprint the rock base.
      const c = r.collider;
      expect(c.surface).toBe('rock');
      expect(c.a.y + c.radius).toBeCloseTo(r.top, 9);
    }
    // No rock collider touches a structure / pipeline collider, nor a mission point (1.2 m sphere).
    const pts: Vector3[] = [];
    for (const t of [...trainingTasks(), ...adverseTasks()]) {
      if (t.kind === 'waypoint') pts.push(new Vector3(t.point.x, t.point.y, t.point.z));
      if (t.kind === 'station' && t.point) pts.push(new Vector3(t.point.x, t.point.y, t.point.z));
    }
    for (const m of MISSIONS) if (m.start !== 'crane') pts.push(new Vector3(m.start.position.x, m.start.position.y, m.start.position.z));
    for (const ip of INSPECTION_POINTS) pts.push(new Vector3(ip.target.x + ip.approach.x * 3, ip.target.y + ip.approach.y * 3, ip.target.z + ip.approach.z * 3));
    for (const p of pts) for (const c of env.physicalColliders) expect(sphereCollider(p, 1.2, c)).toBeNull();
    for (const r of env.rocks) {
      for (const s of COLLIDERS) {
        const bs = colliderBounds(s);
        const br = colliderBounds(r.collider);
        if (Math.hypot(bs.x - br.x, bs.z - br.z) > bs.r + br.r) continue;
        // Test the rock's visible cap points against the structure.
        for (const [lx, lz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const c = Math.cos(r.yaw);
          const sn = Math.sin(r.yaw);
          const x = r.x + lx * r.halfLength * c + lz * r.halfWidth * sn;
          const z = r.z - lx * r.halfLength * sn + lz * r.halfWidth * c;
          expect(sphereCollider(new Vector3(x, r.ground + 0.05, z), 0.05, s)).toBeNull();
        }
      }
    }
    // The berm lies on the pipeline route, between the free span and the PLET.
    expect(env.bermColliders.length).toBeGreaterThan(4);
    expect(env.bermStones.length).toBeGreaterThan(200);
    const mid = env.bermColliders[Math.floor(env.bermColliders.length / 2)].a;
    expect(Math.min(...PIPELINE_PATH.map((p) => Math.hypot(p.x - mid.x, p.z - mid.z)))).toBeLessThan(1e-6);
  });

  it('the physical world does not depend on the graphics quality (render uses the same rock list)', () => {
    const env = getEnvironment();
    const perQuality = withDocument(() =>
      (['low', 'medium', 'high'] as const).map((q) => {
        const build = createSeabed(q, { environment: env });
        let boulderVerts = 0;
        let instancedStones = 0;
        build.group.traverse((o) => {
          if (o.name === 'boulders') boulderVerts += (o as Mesh).geometry.attributes.position.count;
          if (o.name === 'rocks') instancedStones += (o as unknown as { count: number }).count;
        });
        const res = {
          rocks: build.environment.rocks,
          colliders: build.environment.physicalColliders,
          boulderVerts,
          instancedStones,
          tiles: build.stats.loadedTiles,
        };
        build.dispose();
        return res;
      }),
    );
    const vertsPerRock = (detail: number) => 10 * (detail + 1) ** 2 + 2; // indexed icosphere (three r180)
    for (const [k, r] of perQuality.entries()) {
      expect(r.rocks).toBe(env.rocks);
      expect(r.colliders).toBe(env.physicalColliders);
      // Visual mesh detail per quality: low 2 / medium 3 / high 4 (finer facets since the v3.2 rock art pass).
      expect(r.boulderVerts).toBe(env.rocks.length * vertsPerRock(k + 2));
      // Berm stones are part of the instanced stones for every quality.
      expect(r.instancedStones).toBeGreaterThan(env.bermStones.length);
      expect(r.tiles).toBeGreaterThan(20);
    }
  });

  it('boulder meshes follow their colliders within ~10 %', () => {
    const env = getEnvironment();
    const rocks = env.rocks.slice(0, 120);
    const geo = buildBoulderGeometry(rocks, 2);
    const pos = geo.attributes.position as BufferAttribute;
    const nv = pos.count / rocks.length;
    const p = new Vector3();
    rocks.forEach((r, k) => {
      const scale = (r.height + r.halfWidth) / 2;
      let topY = -Infinity;
      for (let v = 0; v < nv; v++) {
        p.fromBufferAttribute(pos, k * nv + v);
        if (p.y < r.ground) continue; // folded below the base, inside the seabed
        topY = Math.max(topY, p.y);
        const d = capsuleSurfaceDistance(p, r.collider);
        expect(Math.abs(d)).toBeLessThan(BOULDER_NOISE * scale + 0.04 * r.collider.radius + 1e-3);
      }
      // Visible height matches the collider top within 10 % of the rock height + noise bound.
      expect(Math.abs(topY - r.top)).toBeLessThan(0.1 * r.height + BOULDER_NOISE * scale);
    });
  });

  it('grid queries equal a brute-force scan and stay cheap', () => {
    const env = getEnvironment();
    const grid = env.grid;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out: Collider[] = [];
    for (let i = 0; i < 300; i++) {
      const x = WORLD_BOUNDS.minX + rnd() * 380;
      const z = WORLD_BOUNDS.minZ + rnd() * 350;
      const e = 0.5 + rnd() * 30;
      out.length = 0;
      grid.query(x - e, z - e, x + e, z + e, out);
      const brute = env.physicalColliders.filter((c) => {
        const b = colliderBounds(c);
        const r = c.kind === 'capsule' ? c.radius : 0;
        if (c.kind !== 'capsule') return Math.abs(b.x - x) < e + b.r && Math.abs(b.z - z) < e + b.r;
        const x0 = Math.min(c.a.x, c.b.x) - r;
        const x1 = Math.max(c.a.x, c.b.x) + r;
        const z0 = Math.min(c.a.z, c.b.z) - r;
        const z1 = Math.max(c.a.z, c.b.z) + r;
        return !(x0 > x + e || x1 < x - e || z0 > z + e || z1 < z - e);
      });
      expect(new Set(out)).toEqual(new Set(brute));
      expect(out.length).toBe(new Set(out).size); // no duplicates
    }
    // Cost of the physics-sized query (hull box ≈ 2.7 m) and of a 60 m sonar box.
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 20000; i++) {
      out.length = 0;
      const x = WORLD_BOUNDS.minX + (i % 370);
      const z = WORLD_BOUNDS.minZ + ((i * 7) % 340);
      hits += grid.query(x - 1.4, z - 1.4, x + 1.4, z + 1.4, out).length;
    }
    const small = ((performance.now() - t0) / 20000) * 1000;
    const t1 = performance.now();
    for (let i = 0; i < 2000; i++) {
      out.length = 0;
      const x = WORLD_BOUNDS.minX + (i % 370);
      const z = WORLD_BOUNDS.minZ + ((i * 7) % 340);
      grid.query(x - 61, z - 61, x + 61, z + 61, out);
    }
    const big = ((performance.now() - t1) / 2000) * 1000;
    console.log(`env: ${env.rocks.length} boulders + ${env.bermColliders.length} berm capsules; query 2.8 m box ${small.toFixed(2)} µs (${(hits / 20000).toFixed(2)} hits), 122 m box ${big.toFixed(1)} µs`);
    expect(small).toBeLessThan(20);
    expect(big).toBeLessThan(400);
    // Empty grid is valid.
    expect(new ColliderGrid([]).query(0, 0, 1, 1)).toEqual([]);
  });

  it('secondary structures are solid and match the rendered layout', () => {
    expect(CONTEXT_STRUCTURES.riserBase.x).toBe(CONTEXT_LAYOUT.riserBase.x);
    expect(CONTEXT_STRUCTURES.riserBase.z).toBe(CONTEXT_LAYOUT.riserBase.z);
    expect(CONTEXT_STRUCTURES.riserBase.size).toEqual(CONTEXT_LAYOUT.riserBase.size);
    expect(CONTEXT_STRUCTURES.wellhead2.x).toBe(CONTEXT_LAYOUT.wellhead2.x);
    expect(CONTEXT_STRUCTURES.wellhead2.z).toBe(CONTEXT_LAYOUT.wellhead2.z);
    expect(CONTEXT_STRUCTURES.wellhead2.size).toEqual(CONTEXT_LAYOUT.wellhead2.size);
    const env = getEnvironment();
    for (const s of Object.values(CONTEXT_STRUCTURES)) {
      const top = env.surfaceHeight(s.x, s.z);
      expect(top - env.terrainHeight(s.x, s.z)).toBeGreaterThan(s.size.y);
    }
  });
});
