import { describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS, resolveConditions, visibilityRange, type VisibilityLevel } from '../src/sim/conditions';
import { OPTICS, sunTransmission, waterOptics } from '../src/render/optics';

const LEVELS: VisibilityLevel[] = ['clear', 'normal', 'turbid'];
const cond = (v: VisibilityLevel) => resolveConditions({ ...DEFAULT_CONDITIONS, visibility: v });
const optics = (v: VisibilityLevel) => waterOptics(cond(v));

describe('water presets (Jerlov-type optics)', () => {
  it('visibility: clear > normal > turbid, in plausible ranges', () => {
    const [c, n, t] = LEVELS.map((v) => optics(v).visibility);
    expect(c).toBeGreaterThan(n);
    expect(n).toBeGreaterThan(t);
    expect(c).toBeGreaterThan(25);
    expect(c).toBeLessThan(45);
    expect(n).toBeGreaterThan(12);
    expect(n).toBeLessThan(25);
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(9);
    // The menu helper agrees with the optics.
    LEVELS.forEach((v) => expect(visibilityRange(cond(v))).toBeCloseTo(optics(v).visibility, 6));
    expect(visibilityRange(cond('turbid'))).toBeLessThan(visibilityRange(cond('clear')) / 2);
  });

  it('per-channel attenuation: red is lost fastest; clear oceanic water is bluest, coastal water greenest', () => {
    for (const v of LEVELS) {
      const [r, g, b] = optics(v).ext;
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
    }
    const clear = optics('clear').ext;
    expect(clear[2]).toBeLessThanOrEqual(clear[1]);
    const turbid = optics('turbid').ext;
    expect(turbid[2]).toBeGreaterThan(turbid[1]); // CDOM / particles absorb blue near the coast
    // Spectral contrast shrinks as particle scattering (grey) dominates.
    expect(turbid[0] / turbid[1]).toBeLessThan(clear[0] / clear[1]);
  });

  it('extinction grows with distance and with turbidity (not a uniform fog)', () => {
    const T = (v: VisibilityLevel, d: number) => optics(v).ext.map((c) => Math.exp(-c * d));
    for (const v of LEVELS) {
      const near = T(v, 2);
      const far = T(v, 10);
      near.forEach((x, i) => expect(far[i]).toBeLessThan(x));
      // Contrast of a target at twice the visibility range is below 2 %.
      expect(Math.exp(-optics(v).ext[1] * 2 * optics(v).visibility)).toBeLessThan(0.02);
    }
    const g10 = LEVELS.map((v) => T(v, 10)[1]);
    expect(g10[0]).toBeGreaterThan(g10[1]);
    expect(g10[1]).toBeGreaterThan(g10[2]);
    // At 5 m in turbid water red is far weaker than green: a colour cast, not grey fog.
    const t5 = T('turbid', 5);
    expect(t5[0]).toBeLessThan(t5[1]);
  });

  it('scattering (lamp backscatter / veil), albedo and marine snow grow with turbidity', () => {
    const o = LEVELS.map(optics);
    expect(o[0].scattering).toBeLessThan(o[1].scattering);
    expect(o[1].scattering).toBeLessThan(o[2].scattering);
    expect(o[1].scattering).toBeCloseTo(1, 6); // normal is the reference water
    expect(o[0].albedo).toBeLessThan(o[2].albedo);
    expect(o[0].particleDensity).toBeLessThan(o[1].particleDensity);
    expect(o[1].particleDensity).toBeLessThan(o[2].particleDensity);
    // Veil hue: blue in clear water, greener (g > b) in turbid water.
    expect(o[0].scatter.b).toBeGreaterThan(o[0].scatter.g);
    expect(o[2].scatter.g).toBeGreaterThan(o[2].scatter.b);
  });

  it('sunlight fades with depth, faster in turbid water', () => {
    const c = optics('clear');
    const t = optics('turbid');
    const at = (extraKd: number, d: number) => sunTransmission(d, undefined, extraKd);
    expect(at(c.extraKd, 50).g).toBeGreaterThan(at(t.extraKd, 50).g);
    expect(at(0, 120).g).toBeLessThan(at(0, 30).g);
    expect(at(0, 30).r).toBeLessThan(at(0, 30).b);
    expect(waterOptics(null).ext).toEqual([...OPTICS.extinction]);
  });
});
