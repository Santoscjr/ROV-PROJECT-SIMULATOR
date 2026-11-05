import { Vector3 } from 'three';
import type { Collider } from '../sim/site';
import { colliderBounds, sphereCollider } from '../physics/collision';

/**
 * Forward-looking imaging sonar (simplified): a mechanically swept fan of
 * beams in the vehicle's horizontal plane. Each beam marches through the real
 * scene geometry — seabed height field and structure colliders — and records
 * echo strength vs range. Refreshed a few beams per frame (≈ 2 sweeps/s), with
 * persistence, like a scanning sonar display. Not an acoustic model: no
 * multipath, shadows are geometric only.
 */
export class Sonar {
  readonly canvas: HTMLCanvasElement;
  range = 40;
  readonly fov = 120;
  readonly beams = 90;
  private readonly bins = 80;
  private readonly img: Float32Array;
  private beam = 0;
  private dir = 1;
  private readonly bounds: { x: number; y: number; z: number; r: number }[];
  private readonly p = new Vector3();

  constructor(
    private readonly terrainHeight: (x: number, z: number) => number,
    private readonly colliders: readonly Collider[],
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sonar-view';
    this.img = new Float32Array(this.beams * this.bins);
    this.bounds = colliders.map(colliderBounds);
  }

  /** Scan `count` beams from the vehicle position/heading (deg). */
  scan(pos: Vector3, headingDeg: number, count = 6): void {
    const halfBeamV = (12 * Math.PI) / 180; // vertical half-beamwidth
    for (let k = 0; k < count; k++) {
      const b = this.beam;
      const brg = ((headingDeg - this.fov / 2 + (b + 0.5) * (this.fov / this.beams)) * Math.PI) / 180;
      const dx = Math.sin(brg);
      const dz = -Math.cos(brg);
      const row = b * this.bins;
      for (let i = 0; i < this.bins; i++) this.img[row + i] *= 0.35; // persistence
      let blocked = false;
      const step = this.range / this.bins;
      for (let i = 1; i < this.bins && !blocked; i++) {
        const r = i * step;
        const px = pos.x + dx * r;
        const pz = pos.z + dz * r;
        const spread = r * Math.tan(halfBeamV);
        const ground = this.terrainHeight(px, pz);
        let echo = 0;
        // Seabed inside the lower part of the beam → bottom return (stronger at grazing incidence near the beam axis).
        if (ground > pos.y - spread) {
          echo = 0.35 + 0.4 * Math.min(1, (ground - (pos.y - spread)) / Math.max(spread, 0.5));
          if (ground > pos.y + spread * 0.2) blocked = true; // terrain rising across the beam
        }
        this.p.set(px, pos.y, pz);
        for (let c = 0; c < this.colliders.length; c++) {
          const bd = this.bounds[c];
          if (Math.abs(px - bd.x) > bd.r + spread || Math.abs(pz - bd.z) > bd.r + spread) continue;
          if (Math.abs(pos.y - bd.y) > bd.r + spread) continue;
          if (sphereCollider(this.p, Math.max(0.3, spread * 0.6), this.colliders[c])) {
            echo = 1;
            blocked = true; // acoustic shadow behind hard targets
            break;
          }
        }
        if (echo > 0) this.img[row + i] = Math.max(this.img[row + i], echo * (1 - 0.35 * (r / this.range)));
      }
      this.beam += this.dir;
      if (this.beam >= this.beams - 1 || this.beam <= 0) this.dir = -this.dir;
    }
  }

  draw(cssW: number, cssH: number): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04080b';
    ctx.fillRect(0, 0, W, H);
    const ox = W / 2;
    const oy = H * 0.92;
    const R = Math.min(H * 0.85, W / (2 * Math.sin((this.fov * Math.PI) / 360)) * 0.95);
    const da = ((this.fov / this.beams) * Math.PI) / 180;
    for (let b = 0; b < this.beams; b++) {
      const a0 = -Math.PI / 2 - (this.fov * Math.PI) / 360 + b * da;
      for (let i = 1; i < this.bins; i++) {
        const v = this.img[b * this.bins + i];
        if (v < 0.04) continue;
        const r0 = (i / this.bins) * R;
        const r1 = ((i + 1) / this.bins) * R;
        ctx.beginPath();
        ctx.arc(ox, oy, r1, a0, a0 + da * 1.05);
        ctx.arc(ox, oy, r0, a0 + da * 1.05, a0, true);
        ctx.closePath();
        const g = Math.round(60 + v * 195);
        ctx.fillStyle = `rgb(${Math.round(v * 255)},${g},${Math.round(40 + v * 60)})`;
        ctx.fill();
      }
    }
    // Range rings and labels.
    ctx.strokeStyle = 'rgba(108,196,216,0.35)';
    ctx.fillStyle = 'rgba(201,212,220,0.8)';
    ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", monospace`;
    ctx.lineWidth = dpr;
    for (let k = 1; k <= 4; k++) {
      const r = (k / 4) * R;
      ctx.beginPath();
      ctx.arc(ox, oy, r, -Math.PI / 2 - (this.fov * Math.PI) / 360, -Math.PI / 2 + (this.fov * Math.PI) / 360);
      ctx.stroke();
      ctx.fillText(`${Math.round((k / 4) * this.range)} m`, ox + 4 * dpr, oy - r + 12 * dpr);
    }
    const sweep = -Math.PI / 2 - (this.fov * Math.PI) / 360 + this.beam * da;
    ctx.strokeStyle = 'rgba(242,169,59,0.8)';
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + Math.cos(sweep) * R, oy + Math.sin(sweep) * R);
    ctx.stroke();
  }
}
