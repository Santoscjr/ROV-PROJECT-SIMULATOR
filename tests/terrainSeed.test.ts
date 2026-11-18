import { describe, expect, it } from 'vitest';
import { DEPRESSIONS, SITE_CENTER, fbm, protectedWeight, terrainHeight, getTerrainSeed } from '../src/sim/terrain';
import { CONTEXT_STRUCTURES, LAUNCH_POINT, MANIFOLD, PIPELINE_PATH, PLET, TMS, TREE } from '../src/sim/site';
import { MISSIONS, trainingTasks, adverseTasks } from '../src/mission/catalog';

/** The v3.1 height field, verbatim (reference for seed 0 inside the protected zones). */
function legacyHeight(x: number, z: number): number {
  const smooth = (t: number) => t * t * (3 - 2 * t);
  let h = -113 - -z * 0.06 - x * 0.015;
  h += fbm(x / 45, z / 45, 4) * 3.2;
  h += fbm(x / 9, z / 9, 2) * 0.35;
  h += Math.sin(x * 0.9 + z * 0.35 + fbm(x / 20, z / 20, 2) * 3) * 0.04;
  const r = Math.hypot(x - SITE_CENTER.x, z - SITE_CENTER.z);
  if (r < 55) {
    const flat = -121 + fbm(x / 7, z / 7, 2) * 0.12;
    const t = r <= 26 ? 1 : 1 - smooth((r - 26) / (55 - 26));
    h = h + (flat - h) * t;
  }
  for (const d of DEPRESSIONS) {
    const q = ((x - d.x) / d.rx) ** 2 + ((z - d.z) / d.rz) ** 2;
    if (q < 1) h -= d.depth * smooth(1 - q);
  }
  return h;
}

/** Points that the site, the pipeline and the missions were laid out on (module-load placements). */
function infrastructurePoints(): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  for (const p of PIPELINE_PATH) for (const off of [-3, 0, 3]) pts.push({ x: p.x + off, z: p.z }, { x: p.x, z: p.z + off });
  for (const s of [MANIFOLD, TREE, PLET]) for (const dx of [-4, 0, 4]) for (const dz of [-4, 0, 4]) pts.push({ x: s.position.x + dx, z: s.position.z + dz });
  for (const s of Object.values(CONTEXT_STRUCTURES)) pts.push({ x: s.x, z: s.z });
  pts.push({ x: LAUNCH_POINT.x, z: LAUNCH_POINT.z }, { x: TMS.exit.x, z: TMS.exit.z });
  const tasks = [...trainingTasks(), ...adverseTasks()];
  for (const t of tasks) {
    if (t.kind === 'waypoint') pts.push(t.point);
    if (t.kind === 'station' && t.point) pts.push(t.point);
    if (t.kind === 'inspect') pts.push(t.target, ...(t.post ? [t.post] : []));
  }
  for (const m of MISSIONS) if (m.start !== 'crane') pts.push(m.start.position);
  return pts;
}

describe('terrain seed', () => {
  it('default seed is 0 and reproduces the v3.1 heights in every protected zone', () => {
    expect(getTerrainSeed()).toBe(0);
    let n = 0;
    for (let x = -140; x <= 230; x += 1.7) {
      for (let z = -230; z <= 110; z += 1.9) {
        if (protectedWeight(x, z) < 1) continue;
        n++;
        expect(Math.abs(terrainHeight(x, z) - legacyHeight(x, z))).toBeLessThan(1e-9);
        expect(Math.abs(terrainHeight(x, z, 0) - legacyHeight(x, z))).toBeLessThan(1e-9);
      }
    }
    expect(n).toBeGreaterThan(3000);
  });

  it('protected zones cover every module-load placement (site, pipeline ±3 m, PLET, launch, mission points)', () => {
    for (const p of infrastructurePoints()) {
      expect(protectedWeight(p.x, p.z)).toBe(1);
      for (const seed of [1, 7, 12345, -99]) expect(terrainHeight(p.x, p.z, seed)).toBeCloseTo(legacyHeight(p.x, p.z), 9);
    }
  });

  it('same seed → identical heights; different seed → different relief outside the protected zones', () => {
    let diff = 0;
    let n = 0;
    for (let x = -140; x <= 230; x += 7.3) {
      for (let z = -230; z <= 110; z += 6.1) {
        expect(terrainHeight(x, z, 42)).toBe(terrainHeight(x, z, 42));
        if (protectedWeight(x, z) > 0) continue;
        diff += Math.abs(terrainHeight(x, z, 42) - terrainHeight(x, z, 0));
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
    expect(diff / n).toBeGreaterThan(0.4);
  });

  it('secondary relief (sand waves, mounds, pockmarks) is subtle and continuous', () => {
    let maxDev = 0;
    let changed = 0;
    let maxSlope = 0;
    for (let x = -140; x <= 230; x += 0.9) {
      for (let z = -230; z <= 110; z += 5.3) {
        const dev = Math.abs(terrainHeight(x, z) - legacyHeight(x, z));
        maxDev = Math.max(maxDev, dev);
        if (dev > 0.05) changed++;
        // No step: height change over 0.1 m stays small (≤ ~30° slope even in a pockmark).
        maxSlope = Math.max(maxSlope, Math.abs(terrainHeight(x + 0.1, z) - terrainHeight(x, z)) / 0.1);
      }
    }
    expect(changed).toBeGreaterThan(200);
    expect(maxDev).toBeLessThan(0.7);
    expect(maxSlope).toBeLessThan(0.6);
  });
});
