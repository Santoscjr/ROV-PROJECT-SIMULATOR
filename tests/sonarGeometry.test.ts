import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import * as SonarMod from '../src/render/sonar';
import { Sonar, SONAR_RANGES } from '../src/render/sonar';
import type { Collider } from '../src/sim/site';

/**
 * Deterministic reference scenes for the forward-looking sonar. Everything is
 * synthetic (analytic terrain + hand-built colliders), so every expected
 * range/bearing below is computed from geometry, not tuned to the output.
 *
 * Frame: +Y up, north = -Z, east = +X; heading 0 looks north, beam index grows
 * to starboard (east when heading 0).
 */

const DEG = Math.PI / 180;
/** Values at or below this fraction of the scene maximum count as "no return". */
const FLOOR_REL = 0.02;

const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0): Collider => ({
  kind: 'box',
  center: { x, y, z },
  half: { x: hx, y: hy, z: hz },
  yaw,
});
const capsule = (a: [number, number, number], b: [number, number, number], radius: number): Collider => ({
  kind: 'capsule',
  a: { x: a[0], y: a[1], z: a[2] },
  b: { x: b[0], y: b[1], z: b[2] },
  radius,
});
const flat = (h: number) => () => h;

/** Run until a ping that started after this call has completed (position-latched). */
function fullPing(s: Sonar, pos: Vector3, heading = 0): NonNullable<ReturnType<Sonar['lastPing']>> {
  const n = s.pingCount;
  let guard = 0;
  while (s.pingCount < n + 2 && guard++ < 10000) s.scan(pos, heading, s.beams);
  return s.lastPing()!;
}

function make(terrain: (x: number, z: number) => number, cols: Collider[], o: { range?: number; tilt?: number; q?: 'low' | 'medium' | 'high' } = {}): Sonar {
  const s = new Sonar(terrain, cols);
  if (o.q) s.setQuality(o.q);
  s.setRange(o.range ?? 40);
  s.setTilt(o.tilt ?? 15);
  return s;
}

type P = NonNullable<ReturnType<Sonar['lastPing']>>;
const step = (p: P) => p.range / p.bins;
const binOf = (p: P, r: number) => Math.floor(r / step(p));
/** Relative bearing (deg, + = starboard) of the centre of beam b. */
const bearing = (s: Sonar, p: P, b: number) => -s.fov / 2 + (b + 0.5) * (s.fov / p.beams);
const beamAt = (s: Sonar, p: P, brgDeg: number) => Math.round((brgDeg + s.fov / 2) / (s.fov / p.beams) - 0.5);
const row = (p: P, b: number) => p.data.subarray(b * p.bins, (b + 1) * p.bins);
const maxOf = (a: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i]);
  return m;
};
const argmax = (a: ArrayLike<number>) => {
  let k = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i;
  return k;
};
const firstAbove = (a: ArrayLike<number>, thr: number) => {
  for (let i = 0; i < a.length; i++) if (a[i] > thr) return i;
  return -1;
};

describe('Sonar reference scenes (geometry-driven)', () => {
  // ---------------------------------------------------------------------------
  // (a) Flat vertical wall at known range: strong return at that range, full
  //     acoustic shadow behind it, on the beams the wall subtends.
  // ---------------------------------------------------------------------------
  it('(a) vertical wall: peak at wall range ±1 bin on central beams, nothing behind', () => {
    const D = 25; // face of the wall, m ahead (z = -D)
    const wall = box(0, -10, -D - 0.5, 40, 10, 0.5); // y -20..0, x -40..40, rests on seabed
    const pos = new Vector3(0, -15, 0); // 5 m above a flat seabed at -20
    const s = make(flat(-20), [wall], { tilt: 15 });
    const p = fullPing(s, pos);
    const all = maxOf(p.data);
    // Control scene without the wall: seabed behind D is visible there.
    const ctrl = fullPing(make(flat(-20), [], { tilt: 15 }), pos);

    for (let b = 0; b < p.beams; b++) {
      const brg = bearing(s, p, b);
      if (Math.abs(brg) > 20) continue;
      const r = row(p, b);
      const horiz = D / Math.cos(brg * DEG);
      // The wall face is seen by the rays between the beam top (-5° elevation)
      // and the elevation below which the seabed (5 m down) is hit first:
      // atan(5 / horiz). Its echo therefore lies in the slant-range band
      // [horiz / cos(5°), horiz / cos(atan(5 / horiz))].
      const rNear = horiz / Math.cos(5 * DEG);
      const rFar = horiz / Math.cos(Math.atan(5 / horiz));
      const pk = argmax(r);
      expect(r[pk]).toBeGreaterThan(0.5);
      expect(pk).toBeGreaterThanOrEqual(binOf(p, rNear) - 1);
      expect(pk).toBeLessThanOrEqual(binOf(p, rFar) + 1);
      // Every bin of the band has a return (the wall is continuous).
      for (let k = binOf(p, rNear) + 1; k < binOf(p, rFar); k++) expect(r[k]).toBeGreaterThan(0.2);
      // The wall is the strongest echo of the beam (beats the seabed in front of it).
      expect(r[pk]).toBeGreaterThan(1.5 * maxOf(r.subarray(0, binOf(p, horiz) - 2)));
      // Shadow: nothing at all beyond the wall (seabed is fully hidden)...
      const past = binOf(p, horiz / Math.cos(12 * DEG)) + 2;
      expect(maxOf(r.subarray(past))).toBeLessThanOrEqual(FLOOR_REL * all);
      // ...while the same beam sees seabed there when the wall is removed.
      expect(maxOf(row(ctrl, b).subarray(past))).toBeGreaterThan(0.05);
    }
  });

  it('(a2) vertical wall at tilt 0, vehicle at mid-height: peak exactly at the normal range', () => {
    const D = 20;
    const s = make(flat(-60), [box(0, -10, -D - 0.5, 40, 10, 0.5)], { tilt: 0 });
    const p = fullPing(s, new Vector3(0, -10, 0));
    for (const brg of [-10, -5, 0, 5, 10]) {
      const r = row(p, beamAt(s, p, brg));
      const expected = D / Math.cos(bearing(s, p, beamAt(s, p, brg)) * DEG);
      expect(Math.abs(argmax(r) - binOf(p, expected))).toBeLessThanOrEqual(1);
      expect(maxOf(r)).toBeGreaterThan(0.8);
    }
  });

  // ---------------------------------------------------------------------------
  // (b) Horizontal pipe crossing the fan: returns at the slant range of the pipe
  //     on every beam that it subtends, standing out of the seabed.
  // ---------------------------------------------------------------------------
  it('(b) pipe crossing the fan: return at the pipe range across the beams it subtends', () => {
    const Z = 18;
    const R0 = 0.3;
    const pipe = capsule([-60, -20 + R0, -Z], [60, -20 + R0, -Z], R0);
    const pos = new Vector3(0, -15, 0);
    const s = make(flat(-20), [pipe], { tilt: 15 });
    const p = fullPing(s, pos);
    const ctrl = fullPing(make(flat(-20), [], { tilt: 15 }), pos);
    let checked = 0;
    for (let b = 0; b < p.beams; b++) {
      const brg = bearing(s, p, b);
      if (Math.abs(brg) > 50) continue;
      const horiz = Z / Math.cos(brg * DEG);
      // Nearest pipe surface along the beam: distance to the axis minus radius.
      const rp = Math.hypot(horiz, 5 - R0) - R0;
      const k = binOf(p, rp);
      const win = row(p, b).subarray(k - 2, k + 3);
      const seabedHere = maxOf(row(ctrl, b).subarray(k - 2, k + 3));
      expect(maxOf(win)).toBeGreaterThan(0.3);
      // A steel pipe stands clearly out of the seabed at the same range.
      expect(maxOf(win)).toBeGreaterThan(2 * seabedHere);
      // Peak of the beam is the pipe.
      expect(Math.abs(argmax(row(p, b)) - k)).toBeLessThanOrEqual(2);
      checked++;
    }
    expect(checked).toBeGreaterThan(p.beams / 2);
  });

  // ---------------------------------------------------------------------------
  // (c) Small isolated object at a known bearing: returns only on the beams
  //     inside its angular extent (± one beam width), correct handedness.
  // ---------------------------------------------------------------------------
  for (const side of [30, -30]) {
    it(`(c) small box at bearing ${side > 0 ? '+' : ''}${side}°: returns only within its angular extent`, () => {
      const dist = 20;
      const cx = dist * Math.sin(side * DEG);
      const cz = -dist * Math.cos(side * DEG);
      const y = -10 - dist * Math.tan(15 * DEG); // on the beam axis (tilt 15)
      const h = 0.5;
      const s = make(flat(-300), [box(cx, y, cz, h, h, h)], { tilt: 15 });
      const p = fullPing(s, new Vector3(0, -10, 0));
      // Angular extent from the box corners.
      let lo = 1e9;
      let hi = -1e9;
      for (const sx of [-h, h])
        for (const sz of [-h, h]) {
          const a = Math.atan2(cx + sx, -(cz + sz)) / DEG;
          lo = Math.min(lo, a);
          hi = Math.max(hi, a);
        }
      const bw = s.fov / p.beams;
      const all = maxOf(p.data);
      expect(all).toBeGreaterThan(0.5);
      const hits: number[] = [];
      for (let b = 0; b < p.beams; b++) {
        const brg = bearing(s, p, b);
        const m = maxOf(row(p, b));
        if (m > FLOOR_REL * all) hits.push(b);
        if (brg < lo - bw || brg > hi + bw) expect(m).toBeLessThanOrEqual(FLOOR_REL * all);
      }
      // Every beam whose centre is inside the object sees it.
      for (let b = 0; b < p.beams; b++) {
        const brg = bearing(s, p, b);
        if (brg > lo + 0.1 && brg < hi - 0.1) expect(hits).toContain(b);
      }
      // Handedness: starboard objects on the starboard half of the image.
      for (const b of hits) expect(Math.sign(bearing(s, p, b))).toBe(Math.sign(side));
      // Range of the return: between the nearest and farthest corner (±1 bin).
      const near = Math.hypot(dist - h * 1.5, -10 - y) - 1;
      const far = Math.hypot(dist + h * 1.5, -10 - y) + 1;
      for (const b of hits) {
        const k = argmax(row(p, b));
        expect(k).toBeGreaterThanOrEqual(binOf(p, near) - 1);
        expect(k).toBeLessThanOrEqual(binOf(p, far) + 1);
      }
    });
  }

  it('(c2) heading rotates the scene: object due east is centred at heading 90', () => {
    const s = make(flat(-300), [box(20, -10 - 20 * Math.tan(15 * DEG), 0, 1, 1, 1)], { tilt: 15 });
    const p = fullPing(s, new Vector3(0, -10, 0), 90);
    const mid = beamAt(s, p, 0);
    expect(maxOf(row(p, mid))).toBeGreaterThan(0.5);
    expect(maxOf(row(p, beamAt(s, p, 20)))).toBe(0);
    expect(maxOf(row(p, beamAt(s, p, -20)))).toBe(0);
    // Heading 270 (looking west): object is behind, no returns anywhere.
    const p2 = fullPing(s, new Vector3(0, -10, 0), 270);
    expect(maxOf(p2.data)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (d) Sloping seabed: first-return range follows the geometry.
  // ---------------------------------------------------------------------------
  it('(d) flat seabed: first-return range shrinks with tilt as h / sin(tilt + 10°)', () => {
    const h = 5;
    const pos = new Vector3(0, -15, 0);
    let prev = Infinity;
    for (const tilt of [5, 15, 25, 35]) {
      const s = make(flat(-15 - h), [], { tilt });
      const p = fullPing(s, pos);
      const r = row(p, beamAt(s, p, 0));
      const k = firstAbove(r, 1e-3);
      const expected = h / Math.sin((tilt + 10) * DEG);
      expect(Math.abs(k - binOf(p, expected))).toBeLessThanOrEqual(2);
      expect(k).toBeLessThan(prev);
      prev = k;
    }
  });

  it('(d2) seabed rising to starboard: first-return range decreases port → starboard', () => {
    const slope = 0.15; // dh/dx
    const s = make((x) => -20 + slope * x, [], { tilt: 15 });
    const p = fullPing(s, new Vector3(0, -15, 0));
    const first: number[] = [];
    for (let b = 0; b < p.beams; b++) first.push(firstAbove(row(p, b), 1e-3));
    const valid = first.filter((k) => k >= 0);
    expect(valid.length).toBeGreaterThan(p.beams * 0.8);
    for (let b = 1; b < p.beams; b++) {
      if (first[b] < 0 || first[b - 1] < 0) continue;
      expect(first[b]).toBeLessThanOrEqual(first[b - 1] + 1);
    }
    // Analytic check at ±45°: ground under a ray at elevation el, bearing β:
    // -15 + r sin(el) = -20 + slope * r cos(el) sin(β); first return at el = -25°.
    for (const brg of [-45, 0, 45]) {
      const b = beamAt(s, p, brg);
      const be = bearing(s, p, b) * DEG;
      const el = -25 * DEG;
      const rExp = 5 / (slope * Math.cos(el) * Math.sin(be) - Math.sin(el));
      expect(Math.abs(first[b] - binOf(p, rExp))).toBeLessThanOrEqual(2);
    }
    expect(first[beamAt(s, p, 50)]).toBeLessThan(first[beamAt(s, p, -50)] - 5);
  });

  it('(d3) seabed ridge casts a terrain shadow behind it', () => {
    // A 3 m ridge at 15 m ahead on a flat bottom 5 m below the vehicle.
    const ridge = (_x: number, z: number) => -20 + 3 * Math.exp(-(((z + 15) / 1.2) ** 2));
    const s = make(ridge, [], { tilt: 15 });
    const p = fullPing(s, new Vector3(0, -15, 0));
    const r = row(p, beamAt(s, p, 0));
    // Ray grazing the ridge crest (2 m below the vehicle at 15 m) reaches the
    // bottom (5 m below) at 15 * 5 / 2 = 37.5 m: shadow from ~16 m to ~37 m.
    expect(maxOf(r.subarray(binOf(p, 18), binOf(p, 35)))).toBe(0);
    expect(maxOf(r.subarray(binOf(p, 13), binOf(p, 16)))).toBeGreaterThan(0.2);
    expect(maxOf(r.subarray(binOf(p, 38.5)))).toBeGreaterThan(0.02);
  });

  // ---------------------------------------------------------------------------
  // (e) Occlusion between objects.
  // ---------------------------------------------------------------------------
  it('(e) object behind another: no return from the hidden one in occluded beams', () => {
    const front = box(0, -10, -12, 1.5, 3, 0.5); // ±7.1° at 11.5 m
    const back = box(0, -10, -25, 6, 3, 0.5); // ±13.5° at 24.5 m
    const s = make(flat(-300), [front, back], { tilt: 0 });
    const p = fullPing(s, new Vector3(0, -10, 0));
    const solo = fullPing(make(flat(-300), [back], { tilt: 0 }), new Vector3(0, -10, 0));
    const k0 = binOf(p, 24);
    let visible = 0;
    for (let b = 0; b < p.beams; b++) {
      const brg = Math.abs(bearing(s, p, b));
      const backPart = maxOf(row(p, b).subarray(k0));
      if (brg < 5) {
        // Without the front box this beam does see the back one.
        expect(maxOf(row(solo, b).subarray(k0))).toBeGreaterThan(0.5);
        expect(backPart).toBe(0);
      }
      if (brg > 9 && brg < 12.5) {
        expect(backPart).toBeGreaterThan(0.5);
        visible++;
      }
    }
    expect(visible).toBeGreaterThan(2);
  });

  // ---------------------------------------------------------------------------
  // (f) Things that do not exist must not echo.
  // ---------------------------------------------------------------------------
  it('(f) empty scene over a deep seabed: no returns at all', () => {
    for (const range of SONAR_RANGES) {
      const s = make(flat(-500), [], { range, tilt: 15 });
      expect(maxOf(fullPing(s, new Vector3(0, -10, 0)).data)).toBe(0);
    }
  });

  it('(f2) objects outside the fan, beyond range or above the vertical beam give no returns', () => {
    const pos = new Vector3(0, -10, 0);
    const at = (brg: number, d: number, dy: number) =>
      box(d * Math.sin(brg * DEG), -10 + dy, -d * Math.cos(brg * DEG), 1, 1, 1);
    // tilt 0: vertical beam ±10°
    const cases: Collider[] = [
      at(75, 20, 0), // outside the 130° fan (half-fov 65° + its own 3° extent)
      at(-75, 20, 0),
      at(180, 10, 0), // behind
      at(0, 43, 0), // beyond 40 m range
      at(0, 20, 20 * Math.tan(20 * DEG)), // 20° above the beam axis
      at(0, 20, -20 * Math.tan(20 * DEG)), // 20° below
    ];
    for (const c of cases) {
      const s = make(flat(-500), [c], { tilt: 0 });
      expect(maxOf(fullPing(s, pos).data)).toBe(0);
    }
  });

  it('(f3) display noise (speckle) stays below the detection threshold at every gain', () => {
    const level = SonarMod.sonarDisplayLevel;
    expect(typeof level).toBe('function');
    let noiseMax = 0;
    for (const gain of [0.1, 1, 4])
      for (let rf = 0; rf <= 1; rf += 0.05)
        for (let n = 0; n <= 1; n += 0.05) noiseMax = Math.max(noiseMax, level(0, rf, gain, n));
    expect(noiseMax).toBeLessThan(SonarMod.SONAR_DETECT_LEVEL);
    // A weak seabed echo (0.06 at the far edge, minimum speckle) at gain 1 is above it.
    expect(level(0.06, 1, 1, 0)).toBeGreaterThan(SonarMod.SONAR_DETECT_LEVEL);
  });

  // ---------------------------------------------------------------------------
  // (g) Range setting rescales the bin, gain scales the display only, quality
  //     changes resolution but not the measured range.
  // ---------------------------------------------------------------------------
  it('(g) range setting rescales the wall bin; beyond range the wall vanishes', () => {
    const D = 15;
    const scene = () => [box(0, -10, -D - 0.5, 40, 10, 0.5)];
    const pos = new Vector3(0, -10, 0);
    for (const range of [20, 40, 60]) {
      const s = make(flat(-60), scene(), { range, tilt: 0 });
      const p = fullPing(s, pos);
      expect(p.range).toBe(range);
      expect(Math.abs(argmax(row(p, beamAt(s, p, 0))) - binOf(p, D))).toBeLessThanOrEqual(1);
    }
    const s10 = make(flat(-60), scene(), { range: 10, tilt: 0 });
    expect(maxOf(fullPing(s10, pos).data)).toBe(0);
  });

  it('(g2) gain changes the displayed level only, never the ping geometry', () => {
    const scene = () => [box(0, -10, -15.5, 40, 10, 0.5)];
    const pos = new Vector3(0, -10, 0);
    const a = make(flat(-20), scene(), { tilt: 10 });
    const b = make(flat(-20), scene(), { tilt: 10 });
    a.setGain(0.3);
    b.setGain(3);
    const pa = fullPing(a, pos);
    const pb = fullPing(b, pos);
    expect(Array.from(pb.data)).toEqual(Array.from(pa.data));
    const level = SonarMod.sonarDisplayLevel;
    for (const e of [0.05, 0.2, 0.5])
      expect(level(e, 0.5, 3, 0.5)).toBeGreaterThan(level(e, 0.5, 0.3, 0.5));
  });

  it('(g3) quality changes resolution, not the measured range', () => {
    const D = 22;
    for (const q of ['low', 'medium', 'high'] as const) {
      const s = make(flat(-60), [box(0, -10, -D - 0.5, 40, 10, 0.5)], { tilt: 0, q });
      const p = fullPing(s, new Vector3(0, -10, 0));
      const pk = argmax(row(p, beamAt(s, p, 0)));
      expect(Math.abs((pk + 0.5) * step(p) - D)).toBeLessThanOrEqual(1.5 * step(p));
    }
  });
});

describe('sonar update rate is the sensor rate, not the frame rate (v3.2)', () => {
  it('completes pings at ~sensorRate Hz whether frames are fast or slow', async () => {
    const { Sonar } = await import('../src/render/sonar');
    const { Vector3 } = await import('three');
    const pings = (fps: number) => {
      const s = new Sonar(() => -200, []);
      let n = 0;
      let last = s.lastPing();
      const dt = 1 / fps;
      for (let t = 0; t < 4; t += dt) {
        s.scanFor(dt, new Vector3(0, -100, 0), 0);
        if (s.lastPing() !== last) {
          n++;
          last = s.lastPing();
        }
      }
      return n / 4;
    };
    const fast = pings(120);
    const slow = pings(8);
    expect(fast).toBeGreaterThan(3.5);
    expect(fast).toBeLessThan(6.5);
    expect(Math.abs(fast - slow)).toBeLessThan(1.5);
  });
});
