import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Sonar } from '../src/render/sonar';
import type { Collider } from '../src/sim/site';

const box = (x: number, y: number, z: number, hx = 2, hy = 1.5, hz = 1): Collider => ({
  kind: 'box',
  center: { x, y, z },
  half: { x: hx, y: hy, z: hz },
  yaw: 0,
});

function ping(s: Sonar, pos: Vector3, heading = 0): void {
  const n = s.pingCount;
  let guard = 0;
  // Two full pings so the position-latched one is complete.
  while (s.pingCount < n + 1 && guard++ < 1000) s.scan(pos, heading);
}

function rangeOf(s: Sonar, bin: number): number {
  const p = s.lastPing()!;
  return ((bin + 0.5) / p.bins) * p.range;
}

function beamRow(s: Sonar, b: number): Float32Array {
  const p = s.lastPing()!;
  return p.data.subarray(b * p.bins, (b + 1) * p.bins);
}

describe('Sonar scan', () => {
  const pos = new Vector3(0, -2, 0);
  // Seabed 3 m below the vehicle, box standing on it 15 m ahead (-z at heading 0).
  const seabed = () => -5;
  const ahead = [box(0, -3.5, -15)];

  it('box 15 m ahead gives strong central returns at ~15 m and shadow behind', () => {
    const s = new Sonar(seabed, ahead);
    ping(s, pos);
    const mid = Math.floor(s.beams / 2);
    const row = beamRow(s, mid);
    let peak = 0;
    let pk = 0;
    row.forEach((v, i) => {
      if (v > peak) {
        peak = v;
        pk = i;
      }
    });
    expect(peak).toBeGreaterThan(0.7);
    expect(Math.abs(rangeOf(s, pk) - 15)).toBeLessThan(2);
    // Shadow: seabed echo behind the box is attenuated vs a beam far off to the side.
    const side = beamRow(s, 4);
    const mean = (r: Float32Array) => {
      let a = 0;
      let n = 0;
      for (let i = 0; i < r.length; i++) {
        const m = rangeOf(s, i);
        if (m >= 19 && m <= 25) (a += r[i]), n++;
      }
      return a / n;
    };
    expect(mean(side)).toBeGreaterThan(0.05);
    expect(mean(row)).toBeLessThan(mean(side) * 0.4);
    // No structure-strength echo beyond the box on the central beam.
    for (let i = 0; i < row.length; i++) if (rangeOf(s, i) > 18) expect(row[i]).toBeLessThan(0.6);
    // Off to the side the seabed is visible but never "strong".
    expect(Math.max(...side)).toBeLessThan(0.6);
  });

  it('nothing ahead over deep seabed gives no strong returns', () => {
    const s = new Sonar(() => -300, []);
    ping(s, pos);
    const p = s.lastPing()!;
    expect(Math.max(...p.data)).toBeLessThan(0.05);
  });

  it('range change rescales the echo position', () => {
    const s = new Sonar(seabed, ahead);
    ping(s, pos);
    const peakRange = () => {
      const row = beamRow(s, Math.floor(s.beams / 2));
      let pk = 0;
      row.forEach((v, i) => {
        if (v > row[pk]) pk = i;
      });
      return rangeOf(s, pk);
    };
    expect(Math.abs(peakRange() - 15)).toBeLessThan(2);
    s.setRange(20);
    expect(s.range).toBe(20);
    ping(s, pos);
    expect(s.lastPing()!.range).toBe(20);
    expect(Math.abs(peakRange() - 15)).toBeLessThan(2);
    s.setRange(10); // box beyond range
    ping(s, pos);
    expect(Math.max(...beamRow(s, Math.floor(s.beams / 2)))).toBeLessThan(0.6);
  });

  it('quality presets set beams x bins', () => {
    const s = new Sonar(seabed, ahead);
    s.setQuality('low');
    expect([s.beams, s.bins]).toEqual([48, 80]);
    s.setQuality('high');
    expect([s.beams, s.bins]).toEqual([128, 192]);
    ping(s, pos);
    expect(s.lastPing()!.data.length).toBe(128 * 192);
  });

  it('scans a medium frame in < 6 ms', () => {
    const h = (x: number, z: number) => -8 + Math.sin(x * 0.2) * Math.cos(z * 0.15) * 1.2 + 0.02 * z;
    const cols: Collider[] = [
      box(5, -7, -20, 3, 1, 1.5),
      { kind: 'capsule', a: { x: -10, y: -7, z: -10 }, b: { x: 8, y: -7, z: -35 }, radius: 0.3 },
    ];
    const s = new Sonar(h, cols);
    const p = new Vector3(0, -3, 0);
    for (let i = 0; i < 30; i++) s.scan(p, 20, 7); // warm-up
    const frames = 280;
    let worst = 0;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      const a = performance.now();
      s.scan(p, 20, 7);
      worst = Math.max(worst, performance.now() - a);
    }
    const avg = (performance.now() - t0) / frames;
    console.log(`sonar medium: avg ${avg.toFixed(2)} ms/frame, worst ${worst.toFixed(2)} ms`);
    expect(avg).toBeLessThan(6);
  });
});
