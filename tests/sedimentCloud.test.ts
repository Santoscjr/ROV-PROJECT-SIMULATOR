import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SedimentCloud, erf, type CurrentSampler, type SedimentSource } from '../src/sim/sedimentCloud';
import { sedimentAlbedo, sedimentAt, sedimentProps, type SedimentMix } from '../src/sim/sediment';

const MUD: SedimentMix = { mud: 1, sand: 0, gravel: 0 };
const SAND: SedimentMix = { mud: 0, sand: 1, gravel: 0 };
const GRAVEL: SedimentMix = { mud: 0, sand: 0, gravel: 1 };
const flat = () => 0;

function cloudOf(mix: SedimentMix, extra: Partial<ConstructorParameters<typeof SedimentCloud>[0]> = {}): SedimentCloud {
  return new SedimentCloud({ ground: flat, mix: () => mix, ...extra });
}

/** Run `seconds` at dt with a source of `amount` at height `h` (or no source). */
function run(c: SedimentCloud, seconds: number, amount: number, h = 1.2, current?: CurrentSampler, dt = 1 / 30): void {
  const src: SedimentSource = { amount, x: 0, y: h, z: 0 };
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) c.step(dt, amount > 0 ? src : null, current);
}

function centroid(c: SedimentCloud): Vector3 {
  const v = new Vector3();
  let m = 0;
  for (const p of c.puffs) {
    v.x += p.x * p.mass;
    v.y += p.y * p.mass;
    v.z += p.z * p.mass;
    m += p.mass;
  }
  return v.multiplyScalar(1 / Math.max(m, 1e-9));
}

const uniformCurrent =
  (x: number, z: number): CurrentSampler =>
  (_p, out) =>
    out.set(x, 0, z);

describe('sediment resuspension cloud', () => {
  it('emits nothing with zero disturbance, when off, or from high above the seabed', () => {
    const a = cloudOf(MUD);
    run(a, 5, 0);
    expect(a.count).toBe(0);
    const b = cloudOf(MUD);
    run(b, 5, 1, 9); // 9 m altitude: wash cannot reach the bed
    expect(b.count).toBe(0);
    expect(b.totalMass).toBe(0);
    const c = cloudOf(MUD);
    c.strength = 0;
    run(c, 5, 1);
    expect(c.count).toBe(0);
    // Close to the bed it does emit.
    const d = cloudOf(MUD);
    run(d, 2, 1);
    expect(d.count).toBeGreaterThan(0);
    expect(d.totalMass).toBeGreaterThan(1);
  });

  it('mud > sand > gravel for equal forcing (mass and peak density)', () => {
    const masses = [MUD, SAND, GRAVEL].map((m) => {
      const c = cloudOf(m);
      run(c, 3, 0.8);
      return { mass: c.totalMass, peak: c.densityAt(centroid(c)) };
    });
    expect(masses[0].mass).toBeGreaterThan(masses[1].mass * 1.5);
    expect(masses[1].mass).toBeGreaterThan(masses[2].mass * 3);
    expect(masses[0].peak).toBeGreaterThan(masses[1].peak);
    expect(masses[1].peak).toBeGreaterThan(masses[2].peak);
    // The shared contract agrees.
    expect(sedimentProps(MUD).erodibility).toBeGreaterThan(sedimentProps(SAND).erodibility);
    expect(sedimentProps(SAND).settleTime).toBeGreaterThan(sedimentProps(GRAVEL).settleTime);
  });

  it('the stronger the resuspension setting, the denser the cloud', () => {
    const lo = cloudOf(MUD);
    lo.strength = 0.5;
    const hi = cloudOf(MUD);
    hi.strength = 2;
    run(lo, 2, 0.6);
    run(hi, 2, 0.6);
    expect(hi.totalMass).toBeGreaterThan(lo.totalMass * 2);
  });

  it('drifts downstream with the current and grows', () => {
    const c = cloudOf(MUD);
    const cur = uniformCurrent(0.15, 0);
    run(c, 3, 1, 1.2, cur);
    const c0 = centroid(c);
    const s0 = Math.max(...c.puffs.map((p) => p.sigma));
    run(c, 20, 0, 1.2, cur);
    const c1 = centroid(c);
    expect(c1.x - c0.x).toBeGreaterThan(2.4); // ≈ 0.15 m/s × 20 s = 3 m
    expect(c1.x - c0.x).toBeLessThan(3.3);
    expect(Math.abs(c1.z - c0.z)).toBeLessThan(0.3);
    expect(Math.max(...c.puffs.map((p) => p.sigma))).toBeGreaterThan(s0);
    // Opacity follows the cloud: the old source position clears, downstream does not.
    const eye = { x: c1.x, y: 1, z: -6 };
    expect(c.lineOfSightOpacity(eye, { x: c1.x, y: 1, z: 6 })).toBeGreaterThan(c.lineOfSightOpacity({ x: -1, y: 1, z: -6 }, { x: -1, y: 1, z: 6 }));
    // Still water: no drift.
    const s = cloudOf(MUD);
    run(s, 3, 1);
    const a = centroid(s);
    run(s, 20, 0);
    expect(Math.hypot(centroid(s).x - a.x, centroid(s).z - a.z)).toBeLessThan(0.3);
  });

  it('rises a little with the jet, then settles and dissipates over its settleTime', () => {
    const c = cloudOf(MUD);
    run(c, 2, 1);
    const yJet = centroid(c).y;
    expect(yJet).toBeGreaterThan(0.3);
    const m0 = c.totalMass;
    const settle = sedimentProps(MUD).settleTime; // 40 s
    run(c, settle, 0);
    const m1 = c.totalMass;
    expect(m1).toBeLessThan(m0 * 0.5);
    expect(m1).toBeGreaterThan(m0 * 0.1);
    expect(centroid(c).y).toBeLessThan(yJet + 0.5);
    run(c, settle * 5, 0);
    expect(c.count).toBe(0);
    // Sand settles much sooner than mud.
    const s = cloudOf(SAND);
    run(s, 2, 1);
    const ms = s.totalMass;
    run(s, 16, 0);
    expect(s.totalMass / ms).toBeLessThan(0.15);
  });

  it('keeps the total mass, puff count and density bounded under sustained forcing', () => {
    const c = cloudOf(MUD, { maxPuffs: 24 });
    c.strength = 2;
    let maxPeak = 0;
    for (let k = 0; k < 12; k++) {
      run(c, 10, 1, 0.8, uniformCurrent(0.05, 0.02));
      expect(c.count).toBeLessThanOrEqual(24);
      expect(c.totalMass).toBeLessThanOrEqual(160 + 1e-6);
      for (const p of c.puffs) maxPeak = Math.max(maxPeak, c.densityAt(p));
    }
    expect(Number.isFinite(maxPeak)).toBe(true);
    expect(maxPeak).toBeLessThan(40);
    expect(maxPeak).toBeGreaterThan(0.5);
  });

  it('is deterministic for identical inputs', () => {
    const mk = () => {
      const c = new SedimentCloud({ ground: flat, mix: (x, z) => sedimentAt(x, z, 3) });
      const cur = uniformCurrent(0.08, -0.04);
      for (let i = 0; i < 300; i++) {
        const t = i / 30;
        c.step(1 / 30, { amount: 0.5 + 0.5 * Math.sin(t), x: t * 0.2, y: 1, z: 0 }, cur);
      }
      return c.puffs.map((p) => ({ ...p }));
    };
    const a = mk();
    expect(a.length).toBeGreaterThan(0);
    expect(mk()).toEqual(a);
  });

  it('line-of-sight optical depth matches a numerical integral of densityAt', () => {
    const c = cloudOf(MUD);
    run(c, 3, 1, 1.2, uniformCurrent(0.1, 0));
    run(c, 4, 0, 1.2, uniformCurrent(0.1, 0));
    const g = centroid(c);
    const from = { x: g.x - 7, y: g.y + 0.3, z: g.z - 2 };
    const to = { x: g.x + 6, y: g.y - 0.1, z: g.z + 1 };
    const N = 4000;
    const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    let num = 0;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      num += c.densityAt({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t });
    }
    num *= len / N;
    expect(c.opticalDepth(from, to)).toBeCloseTo(num, 3);
    expect(c.lineOfSightOpacity(from, to)).toBeGreaterThan(0.5);
    expect(c.lineOfSightOpacity({ x: g.x + 50, y: 5, z: 0 }, { x: g.x + 60, y: 5, z: 0 })).toBeLessThan(1e-6);
    expect(erf(0.5)).toBeCloseTo(0.5205, 4);
  });

  it('relevant(k) keeps the total optical mass of the cloud for a camera', () => {
    const c = cloudOf(MUD);
    // A moving source → several separate puffs.
    for (let i = 0; i < 180; i++) c.step(1 / 30, { amount: 1, x: i * 0.05, y: 1, z: 0 }, null);
    expect(c.count).toBeGreaterThan(3);
    const views = c.relevant(3, { x: 0, y: 1.5, z: -4 });
    expect(views.length).toBe(3);
    const mass = views.reduce((s, v) => s + v.density * Math.pow(Math.PI, 1.5) * v.sigma ** 3, 0);
    expect(mass).toBeCloseTo(c.totalMass, 6);
    expect(c.relevant(0, { x: 0, y: 0, z: 0 })).toEqual([]);
  });

  it('sediment albedo: sand is lighter than mud', () => {
    const m = sedimentAlbedo(MUD);
    const s = sedimentAlbedo(SAND);
    expect(s[0] + s[1] + s[2]).toBeGreaterThan(m[0] + m[1] + m[2]);
  });
});
