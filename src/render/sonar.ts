import { Vector3 } from 'three';
import type { Collider } from '../sim/site';
import { colliderBounds, sphereCollider } from '../physics/collision';

/**
 * Forward-looking imaging sonar (FLS). The whole 130° fan is imaged per ping;
 * the ping is computed incrementally over several frames (scan(..., count)),
 * and the last COMPLETE ping is displayed (double buffer, no tearing).
 *
 * Echoes come only from real scene geometry: the seabed height field (inside
 * the ±10° vertical beam, strength by grazing angle) and structure colliders
 * (sphere probe whose radius grows with range). Structures cast a geometric
 * shadow (their echoes are hidden, seabed is attenuated behind them).
 * Not a full acoustic model: no multipath, no refraction.
 */

export type SonarQuality = 'low' | 'medium' | 'high';
export const SONAR_RANGES = [10, 20, 40, 60] as const;
const QUALITY: Record<SonarQuality, { beams: number; bins: number }> = {
  low: { beams: 48, bins: 80 },
  medium: { beams: 96, bins: 128 },
  high: { beams: 128, bins: 192 },
};

const DEG = Math.PI / 180;
const HALF_BEAM_V = 10; // deg, vertical half-beamwidth
const PING_FRAMES = 14; // a full ping completes in ≈ 14 frames (≈ 0.23 s at 60 fps)
const SEABED_SAMPLES = 7;
const STRUCT_OFFSETS = [-10, -5, 0, 5, 10]; // deg about the beam axis

interface Ping {
  data: Float32Array;
  beams: number;
  bins: number;
  range: number;
  heading: number;
  tilt: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Amber/copper palette lookup (256 entries, RGB).
const PALETTE = (() => {
  const stops: [number, number, number, number][] = [
    [0, 5, 3, 2],
    [0.25, 62, 28, 6],
    [0.55, 170, 86, 16],
    [0.8, 238, 150, 44],
    [1, 255, 228, 160],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k];
    const b = stops[k + 1];
    const u = (t - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u;
  }
  return lut;
})();

const SPECKLE_N = 128;
const SPECKLE = (() => {
  const rnd = mulberry32(0x50a4);
  const t = new Float32Array(SPECKLE_N * SPECKLE_N);
  for (let i = 0; i < t.length; i++) t[i] = rnd();
  return t;
})();

export class Sonar {
  range = 40;
  readonly fov = 130;
  /** Vertical beam axis depression below horizontal (deg). */
  tilt = 15;
  /** Display gain multiplier. */
  gain = 1;
  beams = QUALITY.medium.beams;
  bins = QUALITY.medium.bins;
  quality: SonarQuality = 'medium';
  /** Number of completed pings. */
  pingCount = 0;
  /** Measured ping rate (Hz, smoothed). */
  pingRate = 0;

  private _canvas: HTMLCanvasElement | null = null;
  private front: Ping | null = null;
  private work: Ping;
  private beam = 0;
  private lastDone = 0;
  private readonly origin = new Vector3();
  private readonly bounds: { x: number; y: number; z: number; r: number }[];
  private cand: number[] = []; // ping-level broad-phase
  private beamCand: number[] = []; // beam-level narrow list
  private readonly p = new Vector3();
  private readonly fz = new Float32Array(SEABED_SAMPLES);

  // draw caches
  private off: HTMLCanvasElement | null = null;
  private lut: { key: string; bf: Float32Array; rf: Float32Array } | null = null;
  private cacheKey = '';

  constructor(
    private readonly terrainHeight: (x: number, z: number) => number,
    private readonly colliders: readonly Collider[],
  ) {
    this.bounds = colliders.map(colliderBounds);
    this.work = this.newPing();
  }

  /** Lazily created (no DOM needed for scan logic). */
  get canvas(): HTMLCanvasElement {
    if (!this._canvas) {
      if (typeof document === 'undefined') throw new Error('Sonar.canvas requires a DOM');
      this._canvas = document.createElement('canvas');
      this._canvas.className = 'sonar-view';
    }
    return this._canvas;
  }

  setRange(m: number): void {
    const r = SONAR_RANGES.reduce((best, v) => (Math.abs(v - m) < Math.abs(best - m) ? v : best), SONAR_RANGES[0]);
    if (r === this.range) return;
    this.range = r;
    this.restartPing();
  }

  setTilt(deg: number): void {
    this.tilt = Math.max(0, Math.min(45, deg));
    this.restartPing();
  }

  setGain(g: number): void {
    this.gain = Math.max(0.1, Math.min(4, g));
  }

  setQuality(q: SonarQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.beams = QUALITY[q].beams;
    this.bins = QUALITY[q].bins;
    this.work = this.newPing();
    this.restartPing();
  }

  /** Apply operator settings (range, gain, quality, tilt); restarts the ping only on change. */
  configure(c: { range: number; gain: number; quality: SonarQuality; tilt: number }): void {
    this.setRange(c.range);
    this.setGain(c.gain);
    this.setQuality(c.quality);
    if (Math.abs(c.tilt - this.tilt) > 1e-6) this.setTilt(c.tilt);
  }

  /** Last complete ping (read-only view), or null before the first ping finishes. */
  lastPing(): Readonly<Ping> | null {
    return this.front;
  }

  private newPing(): Ping {
    return {
      data: new Float32Array(this.beams * this.bins),
      beams: this.beams,
      bins: this.bins,
      range: this.range,
      heading: 0,
      tilt: this.tilt,
    };
  }

  private restartPing(): void {
    this.beam = 0;
    if (this.work.beams !== this.beams || this.work.bins !== this.bins) this.work = this.newPing();
  }

  /**
   * Advance the current ping by `count` beams (default: enough for a ≈0.23 s ping at 60 fps;
   * a smaller `count` is raised to that minimum so pings stay fast). Position/heading are
   * latched at the start of each ping.
   */
  scan(pos: Vector3, headingDeg: number, count?: number): void {
    const minCount = Math.ceil(this.beams / PING_FRAMES);
    const n = Math.max(minCount, count ?? 0);
    for (let k = 0; k < n; k++) {
      if (this.beam === 0) this.beginPing(pos, headingDeg);
      this.scanBeam(this.beam);
      this.beam++;
      if (this.beam >= this.beams) this.endPing();
    }
  }

  private beginPing(pos: Vector3, headingDeg: number): void {
    const w = this.work;
    w.data.fill(0);
    w.range = this.range;
    w.heading = headingDeg;
    w.tilt = this.tilt;
    this.origin.copy(pos);
    // Broad-phase: colliders whose bound intersects the fan's range and angular sector.
    this.cand.length = 0;
    const foot = 0.2 + this.range * 0.04;
    for (let c = 0; c < this.bounds.length; c++) {
      const b = this.bounds[c];
      const dx = b.x - pos.x;
      const dz = b.z - pos.z;
      const d = Math.hypot(dx, dz);
      const reach = b.r + foot;
      if (d > this.range + reach || Math.abs(b.y - pos.y) > this.range + reach) continue;
      if (d > reach) {
        let off = Math.atan2(dx, -dz) / DEG - headingDeg;
        off = ((((off + 180) % 360) + 360) % 360) - 180;
        if (Math.abs(off) > this.fov / 2 + Math.asin(reach / d) / DEG + 1) continue;
      }
      this.cand.push(c);
    }
  }

  private endPing(): void {
    const done = this.work;
    const old = this.front;
    this.front = done;
    this.work = old && old.beams === this.beams && old.bins === this.bins ? old : this.newPing();
    this.beam = 0;
    this.pingCount++;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.lastDone > 0 && now > this.lastDone) {
      const hz = 1000 / (now - this.lastDone);
      this.pingRate = this.pingRate ? this.pingRate * 0.7 + hz * 0.3 : hz;
    }
    this.lastDone = now;
  }

  private scanBeam(b: number): void {
    const w = this.work;
    const bins = w.bins;
    const step = w.range / bins;
    const brg = (w.heading - this.fov / 2 + (b + 0.5) * (this.fov / w.beams)) * DEG;
    const dx = Math.sin(brg);
    const dz = -Math.cos(brg);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const oz = this.origin.z;
    const row = b * bins;
    const axis = -w.tilt; // deg elevation of beam axis
    const f = this.fz;

    // Narrow-phase list for this beam: colliders near the beam line.
    const bc = this.beamCand;
    bc.length = 0;
    const foot = 0.2 + w.range * 0.04;
    for (let i = 0; i < this.cand.length; i++) {
      const bd = this.bounds[this.cand[i]];
      const rx = bd.x - ox;
      const rz = bd.z - oz;
      const along = rx * dx + rz * dz;
      const lat = Math.abs(rx * dz - rz * dx);
      if (along < -(bd.r + foot) || lat > bd.r + foot + 0.1 * Math.max(0, along)) continue;
      bc.push(this.cand[i]);
    }

    let shadowEnd = 0; // range up to which this beam is in a structure's acoustic shadow
    let hitRun = 0;

    for (let i = 0; i < bins; i++) {
      const r = (i + 0.5) * step;
      const spread = 1 / (1 + 0.02 * r); // spreading + absorption loss
      const shadowed = r < shadowEnd;
      let echo = 0;

      // --- Structures: probe at several elevations inside the vertical beam.
      let structHit = false;
      let hitIdx = 0;
      if (bc.length > 0) {
        const rad = 0.2 + r * 0.04;
        let best = 0;
        for (let e = 0; e < STRUCT_OFFSETS.length && !structHit; e++) {
          const el = (axis + STRUCT_OFFSETS[e]) * DEG;
          const h = r * Math.cos(el);
          this.p.set(ox + dx * h, oy + r * Math.sin(el), oz + dz * h);
          for (let c = 0; c < bc.length; c++) {
            const bd = this.bounds[bc[c]];
            const ex = this.p.x - bd.x;
            const ey = this.p.y - bd.y;
            const ez = this.p.z - bd.z;
            const lim = bd.r + rad;
            if (ex * ex + ey * ey + ez * ez > lim * lim) continue;
            if (sphereCollider(this.p, rad, this.colliders[bc[c]])) {
              structHit = true;
              hitIdx = bc[c];
              best = Math.max(best, 1 - 0.1 * Math.abs(STRUCT_OFFSETS[e]) / HALF_BEAM_V);
              break;
            }
          }
        }
        if (structHit) {
          hitRun++;
          if (!shadowed) {
            if (hitRun <= 2) echo = best * (0.55 + 0.45 * spread);
            if (hitRun === 1) {
              // Geometric shadow length: object height above the seabed over the grazing angle.
              const gnd = this.terrainHeight(this.p.x, this.p.z);
              let top = this.p.y + 0.2;
              for (let up = 0; up < 24; up++) {
                this.p.y += 0.25;
                if (!sphereCollider(this.p, 0.2 + r * 0.04, this.colliders[hitIdx])) break;
                top = this.p.y;
              }
              const height = Math.max(0.5, top - gnd);
              shadowEnd = Math.min(w.range * 2, r + Math.max(1.5, height / Math.tan(Math.max(4, w.tilt) * DEG)));
            }
          }
        } else hitRun = 0;
      }

      // --- Seabed: find where the sphere of radius r meets the bottom inside the vertical beam.
      if (!structHit) {
        const e0 = (axis + HALF_BEAM_V + 2) * DEG; // top of the sampled sector
        const de = ((2 * HALF_BEAM_V + 4) * DEG) / (SEABED_SAMPLES - 1);
        for (let j = 0; j < SEABED_SAMPLES; j++) {
          const el = e0 - j * de;
          const h = r * Math.cos(el);
          f[j] = oy + r * Math.sin(el) - this.terrainHeight(ox + dx * h, oz + dz * h);
        }
        for (let j = 0; j < SEABED_SAMPLES - 1; j++) {
          if (f[j] >= 0 && f[j + 1] < 0) {
            const u = f[j] / (f[j] - f[j + 1]);
            const el = e0 - (j + u) * de;
            const delta = el / DEG - axis;
            if (Math.abs(delta) > HALF_BEAM_V) break;
            const wv = Math.cos((delta / HALF_BEAM_V) * Math.PI * 0.5);
            const h = r * Math.cos(el);
            const hx = ox + dx * h;
            const hz = oz + dz * h;
            const g0 = this.terrainHeight(hx, hz);
            const gx = (this.terrainHeight(hx + 0.5, hz) - g0) / 0.5;
            const gz = (this.terrainHeight(hx, hz + 0.5) - g0) / 0.5;
            const inv = 1 / Math.hypot(gx, 1, gz);
            const rdx = Math.cos(el) * dx;
            const rdz = Math.cos(el) * dz;
            const rdy = Math.sin(el);
            const s = Math.abs(-gx * rdx + rdy - gz * rdz) * inv; // sin(grazing angle)
            echo = (0.1 + 0.5 * Math.pow(s, 0.7)) * (0.35 + 0.65 * wv * wv);
            if (shadowed) echo *= 0.12; // attenuated, not fully blank
            break;
          }
        }
        echo *= 0.6 + 0.4 * spread;
      }

      if (echo > 0) w.data[row + i] = echo;
    }
  }

  draw(cssW: number, cssH: number): void {
    const c = this.canvas;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      this.cacheKey = '';
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050302';
    ctx.fillRect(0, 0, W, H);

    const ox = W / 2;
    const oy = H * 0.94;
    const halfFov = (this.fov / 2) * DEG;
    const R = Math.max(10, Math.min(oy - 16 * dpr, (W / 2 - 4 * dpr) / Math.sin(halfFov)));
    const ping = this.front;

    // Sonar image, re-rendered only when a new ping completes (or view changes).
    if (ping) {
      const iw = Math.max(1, Math.round(cssW));
      const ih = Math.max(1, Math.round(cssH));
      const key = `${this.pingCount}|${iw}x${ih}|${this.gain}`;
      if (key !== this.cacheKey || !this.off) {
        this.renderImage(ping, iw, ih);
        this.cacheKey = key;
      }
      if (this.off) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.off, 0, 0, W, H);
      }
    }

    // Overlays: range rings, bearing ticks, labels, status.
    const range = ping ? ping.range : this.range;
    const heading = ping ? ping.heading : 0;
    const a0 = -Math.PI / 2 - halfFov;
    const a1 = -Math.PI / 2 + halfFov;
    ctx.lineWidth = Math.max(1, dpr * 0.8);
    ctx.strokeStyle = 'rgba(214,140,50,0.35)';
    ctx.fillStyle = 'rgba(244,184,96,0.9)';
    ctx.font = `${Math.round(10 * dpr)}px "IBM Plex Mono", monospace`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (let k = 1; k <= 4; k++) {
      const r = (k / 4) * R;
      ctx.beginPath();
      ctx.arc(ox, oy, r, a0, a1);
      ctx.stroke();
      ctx.fillText(`${Math.round((k / 4) * range)}`, ox + 3 * dpr, oy - r + 11 * dpr);
    }
    // Fan edges
    ctx.beginPath();
    ctx.moveTo(ox + Math.cos(a0) * R, oy + Math.sin(a0) * R);
    ctx.lineTo(ox, oy);
    ctx.lineTo(ox + Math.cos(a1) * R, oy + Math.sin(a1) * R);
    ctx.stroke();
    // Bearing ticks every 30° (compass bearing, heading-up display).
    ctx.textAlign = 'center';
    const first = Math.ceil((heading - this.fov / 2) / 30) * 30;
    for (let brg = first; brg <= heading + this.fov / 2 + 1e-6; brg += 30) {
      const a = -Math.PI / 2 + (brg - heading) * DEG;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(ox + ca * R, oy + sa * R);
      ctx.lineTo(ox + ca * (R + 6 * dpr), oy + sa * (R + 6 * dpr));
      ctx.stroke();
      const label = String(((Math.round(brg) % 360) + 360) % 360).padStart(3, '0');
      ctx.fillText(label, ox + ca * (R + 6 * dpr), oy + sa * (R + 6 * dpr) - 2 * dpr + (sa > -0.2 ? 10 * dpr : 0));
    }
    // Status text
    ctx.textAlign = 'left';
    const rate = this.pingRate > 0 ? this.pingRate.toFixed(1) : '--';
    ctx.fillStyle = 'rgba(255,200,120,0.95)';
    ctx.fillText(
      `RNG ${range}m  GAIN ${this.gain.toFixed(1)}  PING ${rate}Hz  TILT ${this.tilt.toFixed(0)}`,
      6 * dpr,
      13 * dpr,
    );
    if (!ping) ctx.fillText('PINGING...', 6 * dpr, 26 * dpr);
  }

  private renderImage(ping: Ping, iw: number, ih: number): void {
    if (typeof document === 'undefined') return;
    if (!this.off) this.off = document.createElement('canvas');
    const off = this.off;
    if (off.width !== iw || off.height !== ih) {
      off.width = iw;
      off.height = ih;
    }
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(iw, ih);
    const px = img.data;
    const { beams, bins, data } = ping;

    // Pixel → (beam, bin) lookup, cached per geometry.
    const lkey = `${iw}x${ih}|${beams}|${bins}`;
    if (!this.lut || this.lut.key !== lkey) {
      const bf = new Float32Array(iw * ih).fill(-1000);
      const rf = new Float32Array(iw * ih);
      const cx = iw / 2;
      const cy = ih * 0.94;
      const R = Math.max(10, Math.min(cy - 16, (iw / 2 - 4) / Math.sin((this.fov / 2) * DEG)));
      for (let y = 0; y < ih; y++) {
        for (let x = 0; x < iw; x++) {
          const ddx = x + 0.5 - cx;
          const ddy = cy - (y + 0.5);
          const r = Math.hypot(ddx, ddy);
          if (r > R || ddy <= 0) continue;
          const ang = Math.atan2(ddx, ddy) / DEG;
          if (Math.abs(ang) > this.fov / 2) continue;
          bf[y * iw + x] = (ang + this.fov / 2) / (this.fov / beams) - 0.5;
          rf[y * iw + x] = (r / R) * bins - 0.5;
        }
      }
      this.lut = { key: lkey, bf, rf };
    }
    const { bf, rf } = this.lut;
    const sample = (b: number, r: number): number => {
      if (r < 0 || r > bins - 1) return 0;
      const b0 = Math.max(0, Math.min(beams - 2, Math.floor(b)));
      const r0 = Math.min(bins - 2, Math.floor(r));
      const fb = Math.max(0, Math.min(1, b - b0));
      const fr = r - r0;
      const i = b0 * bins + r0;
      const top = data[i] * (1 - fr) + data[i + 1] * fr;
      const bot = data[i + bins] * (1 - fr) + data[i + bins + 1] * fr;
      return top * (1 - fb) + bot * fb;
    };
    const so = this.pingCount * 37;
    const gain = this.gain;
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const p = y * iw + x;
        const o = p * 4;
        const bfv = bf[p];
        if (bfv < -999) {
          px[o] = 5;
          px[o + 1] = 3;
          px[o + 2] = 2;
          px[o + 3] = 255;
          continue;
        }
        const rr = rf[p];
        // Soft blur along range.
        const a = 0.25 * sample(bfv, rr - 0.9) + 0.5 * sample(bfv, rr) + 0.25 * sample(bfv, rr + 0.9);
        const rangeFrac = (rr + 0.5) / bins;
        const tvg = 1 + 2.2 * rangeFrac; // time-varied gain
        const n = SPECKLE[(((y + so) & (SPECKLE_N - 1)) * SPECKLE_N + ((x + (so >> 3)) & (SPECKLE_N - 1)))];
        const v0 = a * tvg * gain * (0.8 + 0.4 * n) + 0.025 + 0.035 * n * (0.4 + rangeFrac);
        const v = 1 - Math.exp(-1.7 * v0);
        const li = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
        px[o] = PALETTE[li];
        px[o + 1] = PALETTE[li + 1];
        px[o + 2] = PALETTE[li + 2];
        px[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
  }
}
