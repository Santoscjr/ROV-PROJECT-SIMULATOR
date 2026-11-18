import type { Object3D, Vector3, WebGLRenderer } from 'three';
import { CameraRig } from './cameras';
import { UnderwaterPass } from './underwaterPass';
import type { CameraFx, CameraStates, ViewLayout, ViewSource } from '../config/settings';
import type { World } from './world';

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
  constructor(
    public source: ViewSource,
    states?: CameraStates,
    private readonly msaa = 0,
  ) {
    this.rig = new CameraRig(1, states);
    if (isCameraSource(source)) this.rig.setMode(source);
  }

  setSource(s: ViewSource): void {
    this.source = s;
    if (isCameraSource(s)) this.rig.setMode(s);
  }

  ensurePass(w: number, h: number): UnderwaterPass {
    if (!this.pass) {
      this.pass = new UnderwaterPass(w, h, this.msaa);
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

/** Everything a camera panel needs from the (single) simulation for one frame. */
export interface PanelEnv {
  world: World;
  dt: number;
  time: number;
  rovRoot: Object3D;
  eye: Object3D;
  headingRad: number;
  tmsMount: Object3D | null;
  terrainHeight: (x: number, z: number) => number;
  fxFor: (mode: string) => CameraFx;
  whiteBalance: (depth: number) => number;
  /** Prepare scene lights for this view (observer aid only for external views). */
  observer: (mode: string, pos: Vector3) => void;
  /** In-scattered ambient for particles (from World.updateEnvironment). */
  ambient: Vector3;
  lightLevel: number;
  seabedBase: number;
}

/**
 * THE camera-panel renderer, used by every panel of every window (main and
 * secondary monitors): same scene preparation, same underwater composite
 * (water optics of the environment), same particles and lamp beams. Panels
 * differ only by camera (position, orientation, optics) and resolution.
 */
export function renderCameraPanel(
  renderer: WebGLRenderer,
  rig: CameraRig,
  pass: UnderwaterPass,
  source: ViewSource,
  vp: Rect,
  cssW: number,
  cssH: number,
  env: PanelEnv,
  wet = 0,
): void {
  const world = env.world;
  rig.tmsMount = env.tmsMount;
  rig.camera.aspect = cssW / cssH;
  rig.update(env.dt, env.rovRoot, env.eye, env.headingRad);
  const cam = rig.camera;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  const depth = -cam.position.y;
  world.preparePanel(cam.position);
  env.observer(rig.mode, cam.position);
  // Same water for every camera: global optics, then the frame-global sediment
  // cloud and lamps (puffs most relevant to THIS camera) — never only panel 1.
  pass.setWater(world.waterOptics);
  pass.setSiltField(world.silt, cam.position);
  pass.setCameraFx(env.fxFor(source), source === 'operational' || source === 'auxiliary');
  pass.update(cam, {
    camDepth: depth,
    seabedDepth: -env.terrainHeight(cam.position.x, cam.position.z) || env.seabedBase,
    time: env.time,
    wet,
    whiteBalance: env.whiteBalance(depth),
  });
  const pr = renderer.getPixelRatio();
  usePanel(renderer, vp);
  pass.render(renderer, world.scene, cam);
  // Particles / lamp beams over the composite, against this panel's depth buffer.
  const fx = world.effects;
  fx.bindPass(pass.depthTexture, pass.cameraUniforms);
  fx.update(cam, {
    time: env.time,
    width: vp.w,
    height: vp.h,
    originX: vp.x,
    originY: vp.y,
    pixelRatio: pr,
    ambient: env.ambient,
    underwater: depth > 0,
    lightLevel: env.lightLevel,
  });
  const ac = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(fx.scene, cam);
  renderer.autoClear = ac;
  world.panelDraws++;
}
