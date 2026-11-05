import type { WebGLRenderer } from 'three';
import { CameraRig } from './cameras';
import { UnderwaterPass } from './underwaterPass';
import type { ViewLayout, ViewSource } from '../config/settings';

export type CameraSource = Exclude<ViewSource, 'sonar' | 'instruments'>;
export const isCameraSource = (s: ViewSource): s is CameraSource => s !== 'sonar' && s !== 'instruments';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Panel rectangles in CSS pixels (top-left origin). Panel 0 is the main (interactive) view. */
export function layoutRects(layout: ViewLayout, w: number, h: number): Rect[] {
  if (layout === 'dual') {
    const hw = Math.floor(w / 2);
    return [
      { x: 0, y: 0, w: hw, h },
      { x: hw, y: 0, w: w - hw, h },
    ];
  }
  if (layout === 'quad') {
    const hw = Math.floor(w / 2);
    const hh = Math.floor(h / 2);
    return [
      { x: 0, y: 0, w: hw, h: hh },
      { x: hw, y: 0, w: w - hw, h: hh },
      { x: 0, y: hh, w: hw, h: h - hh },
      { x: hw, y: hh, w: w - hw, h: h - hh },
    ];
  }
  return [{ x: 0, y: 0, w, h }];
}

/** Rect → WebGL viewport in drawing-buffer pixels (bottom-left origin). */
export function glViewport(r: Rect, canvasH: number, pr: number): Rect {
  return { x: Math.round(r.x * pr), y: Math.round((canvasH - r.y - r.h) * pr), w: Math.max(1, Math.round(r.w * pr)), h: Math.max(1, Math.round(r.h * pr)) };
}

/**
 * A secondary station view: its own camera rig and a lightweight underwater
 * composite (no MSAA, reduced resolution). It shares the single simulation and
 * scene; only the render is repeated. Particles/beams are drawn only on the
 * main view (cost).
 */
export class SecondaryView {
  readonly rig: CameraRig;
  pass: UnderwaterPass | null = null;
  private w = 0;
  private h = 0;
  constructor(public source: ViewSource) {
    this.rig = new CameraRig(1);
    if (isCameraSource(source)) this.rig.setMode(source);
    this.rig.tilt = -25;
  }

  setSource(s: ViewSource): void {
    this.source = s;
    if (isCameraSource(s)) this.rig.setMode(s);
  }

  ensurePass(w: number, h: number): UnderwaterPass {
    if (!this.pass) {
      this.pass = new UnderwaterPass(w, h, 0);
      this.w = w;
      this.h = h;
    } else if (w !== this.w || h !== this.h) {
      this.pass.setSize(w, h);
      this.w = w;
      this.h = h;
    }
    return this.pass;
  }

  dispose(): void {
    this.pass?.dispose();
    this.pass = null;
  }
}

/** Set viewport + scissor for a panel on the default framebuffer. */
export function usePanel(renderer: WebGLRenderer, vp: Rect): void {
  const pr = renderer.getPixelRatio();
  renderer.setViewport(vp.x / pr, vp.y / pr, vp.w / pr, vp.h / pr);
  renderer.setScissor(vp.x / pr, vp.y / pr, vp.w / pr, vp.h / pr);
}
