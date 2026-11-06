import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { getEnvironment, type Rock } from '../src/sim/environment';
import { DEPRESSIONS, terrainHeight } from '../src/sim/terrain';
import { COLLIDERS, FREE_SPAN, MANIFOLD, PIPELINE_PATH, PIPELINE_RADIUS, type CapsuleCollider } from '../src/sim/site';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { sphereCollider } from '../src/physics/collision';
import { SegmentTether } from '../src/physics/segmentTether';
import { Sonar } from '../src/render/sonar';
import { Simulation } from '../src/sim/simulation';

const DT = 1 / 120;
const env = getEnvironment();

function physicsEnv(): PhysicsEnvironment {
  return {
    current: (_p, out) => out.set(0, 0, 0),
    terrainHeight,
    colliders: COLLIDERS,
    queryColliders: env.queryColliders,
  };
}

/** Height of the top of a capsule above (x, z) (null when outside its footprint). */
function capsuleTop(c: CapsuleCollider, x: number, z: number): number | null {
  const abx = c.b.x - c.a.x;
  const abz = c.b.z - c.a.z;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - c.a.x) * abx + (z - c.a.z) * abz) / l2)) : 0;
  const h = Math.hypot(x - c.a.x - abx * t, z - c.a.z - abz * t);
  if (h > c.radius) return null;
  return c.a.y + (c.b.y - c.a.y) * t + Math.sqrt(c.radius * c.radius - h * h);
}

function distToCapsule(p: Vector3, c: CapsuleCollider): number {
  const ab = new Vector3(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
  const ap = new Vector3(p.x - c.a.x, p.y - c.a.y, p.z - c.a.z);
  const l2 = ab.lengthSq();
  const t = l2 > 0 ? Math.max(0, Math.min(1, ap.dot(ab) / l2)) : 0;
  return ap.sub(ab.multiplyScalar(t)).length();
}

/** A large boulder with open seabed around it (no other rock within `clear` m). */
function isolatedBoulder(minHeight: number, clear = 6): Rock {
  const r = env.rocks
    .filter((k) => k.height >= minHeight && k.halfLength < 1.6)
    .find((k) => env.rocks.every((o) => o === k || Math.hypot(o.x - k.x, o.z - k.z) > clear + o.halfLength + k.halfLength));
  if (!r) throw new Error('no isolated boulder');
  return r;
}

/** Place a level ROV so that the bottom of its frame is at (x, yBottom, z) and read the altimeter. */
function altimeterAt(x: number, yBottom: number, z: number): number | null {
  const rov = new RovPhysics();
  rov.reset(new Vector3(x, yBottom + rov.params.size[1] / 2, z), 0);
  return rov.altitude(physicsEnv());
}

/**
 * Independent reference for the 6° single-beam altimeter: brute-force 1 cm
 * ray-march along ~100 directions filling the cone, against the terrain and
 * point-in-collider tests (structures + every rock near the footprint). The
 * nearest echo in the cone is the physically correct reading; the model must
 * find it (within its 7-ray sampling) and can never read longer than the
 * vertical distance below it.
 */
function coneReference(x: number, yBottom: number, z: number, maxT: number): number {
  const o = new Vector3(x, yBottom, z);
  const near: import('../src/sim/site').Collider[] = [];
  env.queryColliders(x - 3, z - 3, x + 3, z + 3, near);
  const all = [...COLLIDERS, ...near];
  const half = (3 * Math.PI) / 180;
  let best = Infinity;
  const p = new Vector3();
  const dirs: Vector3[] = [new Vector3(0, -1, 0)];
  for (let ring = 1; ring <= 4; ring++)
    for (let k = 0; k < 24; k++) {
      const th = (half * ring) / 4;
      const a = (k / 24) * Math.PI * 2;
      dirs.push(new Vector3(Math.sin(th) * Math.cos(a), -Math.cos(th), Math.sin(th) * Math.sin(a)));
    }
  for (const d of dirs)
    for (let t = 0; t < Math.min(best, maxT); t += 0.01) {
      p.copy(o).addScaledVector(d, t);
      if (p.y <= terrainHeight(p.x, p.z) || all.some((c) => sphereCollider(p, 0.002, c) !== null)) {
        best = Math.min(best, t);
        break;
      }
    }
  return best;
}

/** Cone model check: nearest echo in the cone (±2 cm of the dense reference), never longer than the vertical distance. */
function expectCone(alt: number | null, x: number, yBottom: number, z: number, vertical: number): void {
  expect(alt).not.toBeNull();
  const ref = coneReference(x, yBottom, z, vertical + 0.1);
  expect(alt!).toBeGreaterThanOrEqual(ref - 0.02);
  expect(alt!).toBeLessThanOrEqual(Math.min(vertical, ref + 0.05) + 0.02);
}

describe('altimeter = real geometry (terrain, rocks, berm, pipeline, structures)', () => {
  const H = 3;
  it('flat seabed', () => {
    const x = 0;
    const z = -84; // flattened site, no collider below
    const g = terrainHeight(x, z);
    expect(altimeterAt(x, g + H, z)).toBeCloseTo(H, 2);
  });

  it('over a boulder: distance to the rock top, not to the seabed', () => {
    const r = isolatedBoulder(0.6);
    const alt = altimeterAt(r.x, r.top + H, r.z)!;
    expectCone(alt, r.x, r.top + H, r.z, H);
    expect(alt).toBeLessThan(H + 0.02); // rock top, not the seabed
    // Off-centre point on the rock flank: analytic cap height.
    const c = Math.cos(r.yaw);
    const s = Math.sin(r.yaw);
    const x = r.x + s * r.halfWidth * 0.5;
    const z = r.z + c * r.halfWidth * 0.5;
    const top = Math.max(terrainHeight(x, z), capsuleTop(r.collider, x, z)!);
    expectCone(altimeterAt(x, top + H, z), x, top + H, z, H);
    // Beside the rock: the seabed again.
    const xo = r.x + s * (r.halfWidth + 1.5);
    const zo = r.z + c * (r.halfWidth + 1.5);
    expectCone(altimeterAt(xo, terrainHeight(xo, zo) + H, zo), xo, terrainHeight(xo, zo) + H, zo, H);
  });

  it('over a depression (free-span hollow), clear of the pipe', () => {
    const d = DEPRESSIONS[0];
    // A point inside the hollow at least 1.5 m from the pipe axis.
    let best: { x: number; z: number } | null = null;
    for (let a = 0; a < 2 * Math.PI && !best; a += 0.1) {
      const x = d.x + Math.cos(a) * d.rx * 0.45;
      const z = d.z + Math.sin(a) * d.rz * 0.45;
      const near = Math.min(...PIPELINE_PATH.map((p) => Math.hypot(p.x - x, p.z - z)));
      if (near > 1.5) best = { x, z };
    }
    expect(best).not.toBeNull();
    const { x, z } = best!;
    const g = terrainHeight(x, z);
    expectCone(altimeterAt(x, g + H, z), x, g + H, z, H);
  });

  it('over the pipeline at the free span and over the rock berm', () => {
    const p = FREE_SPAN.point;
    const top = p.y + PIPELINE_RADIUS;
    expectCone(altimeterAt(p.x, top + H, p.z), p.x, top + H, p.z, H);
    const b = env.bermColliders[3];
    const mx = (b.a.x + b.b.x) / 2;
    const mz = (b.a.z + b.b.z) / 2;
    // Highest of the (overlapping) berm capsules and the pipe at that point.
    const bt = Math.max(...[...env.bermColliders, ...COLLIDERS.filter((c): c is CapsuleCollider => c.kind === 'capsule')].map((c) => capsuleTop(c, mx, mz) ?? -Infinity));
    expect(bt).toBeGreaterThan(terrainHeight(mx, mz) + 0.6);
    expectCone(altimeterAt(mx, bt + H, mz), mx, bt + H, mz, H);
  });

  it('over a structure (manifold roof)', () => {
    const m = MANIFOLD.position;
    const roof = m.y + MANIFOLD.size.y;
    expectCone(altimeterAt(m.x, roof + H, m.z), m.x, roof + H, m.z, H);
  });

  it('Simulation wires the rock field into physics and altimeter', () => {
    const sim = new Simulation('stabilize', 'free');
    const r = isolatedBoulder(0.6);
    sim.crane = 'released';
    sim.rov.reset(new Vector3(r.x, r.top + H + sim.rov.params.size[1] / 2, r.z), 0);
    expectCone(sim.rov.altitude(sim.env), r.x, r.top + H, r.z, H);
  });
});

describe('ROV vs boulder contact', () => {
  it('no tunnelling at 1.5 m/s: the hull stops against the rock and the hit counts as a seabed impact', () => {
    const r = isolatedBoulder(0.7);
    const e = physicsEnv();
    const rov = new RovPhysics();
    // Approach along the rock's short axis, hull centre at the rock's mid height.
    const c = Math.cos(r.yaw);
    const s = Math.sin(r.yaw);
    const dir = new Vector3(s, 0, c); // across the long axis
    const yaw = Math.atan2(-dir.z, dir.x); // body +x along dir
    const start = new Vector3(r.x, 0, r.z).addScaledVector(dir, -(r.halfWidth + 3.5));
    start.y = Math.max(terrainHeight(start.x, start.z), r.ground) + 0.95;
    rov.reset(start, yaw);
    let minClear = Infinity;
    let maxPen = 0;
    const HULL_R = 0.82;
    for (let i = 0; i < 4 * 120; i++) {
      // Full-power approach: hold 1.5 m/s towards the rock until contact stops it.
      if (rov.contactCount === 0) rov.velocity.set(1.5, 0, 0);
      rov.step(DT, e);
      for (const off of [0.55, -0.55]) {
        const centre = new Vector3(off, 0, 0).applyQuaternion(rov.orientation).add(rov.position);
        const d = distToCapsule(centre, r.collider) - r.collider.radius;
        minClear = Math.min(minClear, d);
        maxPen = Math.max(maxPen, HULL_R - d);
      }
    }
    // The hull never passes through: penetration stays within one step of travel.
    expect(maxPen).toBeLessThan(0.02);
    // It did reach the rock (contact), and did not end on the far side.
    expect(minClear).toBeLessThan(HULL_R + 0.02);
    const along = new Vector3().subVectors(rov.position, new Vector3(r.x, rov.position.y, r.z)).dot(dir);
    expect(along).toBeLessThan(0);
    expect(rov.takeImpacts().some((k) => k.kind === 'seabed' && k.speed > 0.25)).toBe(true);
  });
});

describe('sonar sees boulders through the field broad-phase', () => {
  it('a boulder echoes at its range and bearing; absent without the field', () => {
    const r = isolatedBoulder(0.7, 7);
    // 12 m south-west of the rock, 2.5 m above its top, looking at it.
    const pos = new Vector3(r.x - 8.5, r.top + 2.5, r.z + 8.5);
    const hdg = (Math.atan2(r.x - pos.x, -(r.z - pos.z)) * 180) / Math.PI;
    const run = (withField: boolean) => {
      const s = new Sonar(terrainHeight, [], withField ? env.grid : undefined);
      s.setQuality('high');
      s.setRange(20);
      s.setTilt(10);
      const n = s.pingCount;
      let guard = 0;
      while (s.pingCount < n + 2 && guard++ < 1000) s.scan(pos, hdg, s.beams);
      return { s, p: s.lastPing()! };
    };
    const { s, p } = run(true);
    const base = run(false).p;
    // Strongest excess return over the bare-seabed ping.
    let best = { v: 0, b: 0, i: 0 };
    for (let b = 0; b < p.beams; b++)
      for (let i = 0; i < p.bins; i++) {
        const v = p.data[b * p.bins + i] - base.data[b * p.bins + i];
        if (v > best.v) best = { v, b, i };
      }
    expect(best.v).toBeGreaterThan(0.3);
    const range = ((best.i + 0.5) / p.bins) * p.range;
    // Near face of the rock: slant range to the closest point of its cap.
    let near = Infinity;
    for (let a = 0; a < 2 * Math.PI; a += 0.05)
      for (let f = 0; f <= 1; f += 0.1) {
        const x = r.x + Math.cos(a) * r.halfLength * f;
        const z = r.z + Math.sin(a) * r.halfLength * f;
        const t = capsuleTop(r.collider, x, z);
        if (t !== null && t > r.ground) near = Math.min(near, Math.hypot(x - pos.x, t - pos.y, z - pos.z));
      }
    expect(Math.abs(range - near)).toBeLessThan(0.6);
    const brg = -s.fov / 2 + ((best.b + 0.5) * s.fov) / p.beams;
    const halfAngle = (Math.atan2(r.halfLength, Math.hypot(r.x - pos.x, r.z - pos.z)) * 180) / Math.PI;
    expect(Math.abs(brg)).toBeLessThan(halfAngle + s.fov / p.beams);
  });

  it('per-ping broad-phase cost stays small in a rocky area', () => {
    // Densest 60 m neighbourhood of the field.
    let best = env.rocks[0];
    let bestN = 0;
    for (const r of env.rocks) {
      const n = env.rocks.filter((o) => Math.abs(o.x - r.x) < 30 && Math.abs(o.z - r.z) < 30).length;
      if (n > bestN) (bestN = n), (best = r);
    }
    const pos = new Vector3(best.x, best.top + 4, best.z + 20);
    const time = (field: boolean) => {
      const s = new Sonar(terrainHeight, COLLIDERS, field ? env.grid : undefined);
      s.setQuality('high');
      s.setRange(40);
      for (let i = 0; i < 10; i++) s.scan(pos, 0); // warm-up
      const t0 = performance.now();
      for (let i = 0; i < 56; i++) s.scan(pos, (i % 7) * 3);
      return (performance.now() - t0) / 56;
    };
    const without = time(false);
    const withField = time(true);
    console.log(`sonar high in rocky area (${bestN} rocks within ±30 m): ${without.toFixed(2)} → ${withField.toFixed(2)} ms/frame with rocks`);
    // Rocks add little: the grid hands the ping only the rocks in its range box.
    expect(withField).toBeLessThan(without * 1.5 + 0.5);
  }, 30000);
});

describe('tether vs boulder', () => {
  it('tether nodes draped across a boulder never end up inside it', () => {
    const r = isolatedBoulder(0.8);
    const c = Math.cos(r.yaw);
    const s = Math.sin(r.yaw);
    const across = new Vector3(s, 0, c);
    const a = new Vector3(r.x, 0, r.z).addScaledVector(across, -6);
    const b = new Vector3(r.x, 0, r.z).addScaledVector(across, 6);
    a.y = r.top + 1.5;
    b.y = r.top + 1.5;
    const t = new SegmentTether((_p, o) => o.set(0, 0, 0), { wetWeight: 3, segments: 32 }, terrainHeight, env.allColliders);
    t.payout = 13;
    t.reset(a, b);
    const zero = new Vector3();
    const out = new Vector3();
    let maxPen = 0;
    let touching = 0;
    for (let i = 0; i < 6 * 120; i++) {
      t.step(DT, b, zero, out);
      for (let k = 1; k < t.n; k++) {
        const pen = r.collider.radius + t.config.radius - distToCapsule(t.p[k], r.collider);
        maxPen = Math.max(maxPen, pen);
      }
      touching = t.contacts.structure;
    }
    expect(maxPen).toBeLessThan(0.01);
    // The cable rests on the rock (some nodes in contact with it), not through it.
    expect(touching).toBeGreaterThan(0);
    let onTop = 0;
    for (let k = 1; k < t.n; k++) if (Math.hypot(t.p[k].x - r.x, t.p[k].z - r.z) < r.halfWidth * 0.5) onTop = Math.max(onTop, t.p[k].y);
    expect(onTop).toBeGreaterThan(r.top - 0.05);
  });

  it('tether contact cost with the full rock list stays bounded', () => {
    const t = new SegmentTether((_p, o) => o.set(0, 0, 0), {}, terrainHeight, env.allColliders);
    const t0b = new SegmentTether((_p, o) => o.set(0, 0, 0), {}, terrainHeight, COLLIDERS);
    const a = new Vector3(13.5, -71.5, 6);
    const b = new Vector3(20, -110, -30);
    const zero = new Vector3();
    const out = new Vector3();
    const time = (tt: SegmentTether) => {
      tt.payout = 60;
      tt.reset(a, b);
      for (let i = 0; i < 60; i++) tt.step(DT, b, zero, out);
      const t0 = performance.now();
      for (let i = 0; i < 600; i++) tt.step(DT, b, zero, out);
      return (performance.now() - t0) / 600;
    };
    const base = time(t0b);
    const withRocks = time(t);
    console.log(`tether step: ${base.toFixed(3)} ms (structures) → ${withRocks.toFixed(3)} ms (+${env.physicalColliders.length} rock colliders)`);
    // Without a spatial query in SegmentTether every node bound-checks every rock (see report);
    // keep it within a few times the structure-only cost.
    expect(withRocks).toBeLessThan(base * 5 + 0.3);
  });
});

describe('altimeter beam model (6° cone, body-fixed)', () => {
  it('reads the slant range when the vehicle is tilted, and nothing beyond 50 m', () => {
    const x = 0;
    const z = -84;
    const g = terrainHeight(x, z);
    const rov = new RovPhysics();
    rov.reset(new Vector3(x, g + 4 + rov.params.size[1] / 2, z), 0);
    const level = rov.altitude(physicsEnv())!;
    // Pitch 20°: the body-fixed beam reads the slant distance (longer than the vertical).
    rov.orientation.setFromAxisAngle(new Vector3(0, 0, 1), (20 * Math.PI) / 180);
    const tilted = rov.altitude(physicsEnv())!;
    expect(tilted).toBeGreaterThan(level * 1.03);
    rov.orientation.identity();
    rov.position.y = g + 70;
    expect(rov.altitude(physicsEnv())).toBeNull();
  });
});
