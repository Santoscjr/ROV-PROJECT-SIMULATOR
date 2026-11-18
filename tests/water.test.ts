import { describe, expect, it } from 'vitest';
import { Object3D, Scene, Vector3, Vector4, type WebGLRenderer } from 'three';
import { DEFAULT_CAMERA_FX, type ViewSource } from '../src/config/settings';
import { DEFAULT_CONDITIONS, resolveConditions } from '../src/sim/conditions';
import { SedimentCloud } from '../src/sim/sedimentCloud';
import { createSiltField, waterOptics } from '../src/render/optics';
import { UnderwaterPass } from '../src/render/underwaterPass';
import { WaterEffects } from '../src/render/effects';
import { CameraRig } from '../src/render/cameras';
import { SecondaryView, renderCameraPanel, type PanelEnv } from '../src/render/station';
import type { World } from '../src/render/world';

const GROUND = -100;

/** Minimal WebGLRenderer stand-in: records draws, no GPU. */
function fakeRenderer() {
  const r = {
    autoClear: true,
    draws: 0,
    getPixelRatio: () => 1,
    setViewport: () => {},
    setScissor: () => {},
    setRenderTarget: () => {},
    clear: () => {},
    render: () => {
      r.draws++;
    },
  };
  return r;
}

/** World stand-in with the REAL shared water state (optics, sediment cloud, lamps, effects). */
function harness(visibility: 'clear' | 'normal' | 'turbid' = 'normal') {
  const cloud = new SedimentCloud({ ground: () => GROUND, mix: () => ({ mud: 0.8, sand: 0.2, gravel: 0 }) });
  const silt = createSiltField(cloud);
  silt.lamps.count = 2;
  silt.lamps.pos[0].set(0.6, GROUND + 1.3, 0.3);
  silt.lamps.pos[1].set(0.6, GROUND + 1.3, -0.3);
  silt.lamps.intensity[0] = silt.lamps.intensity[1] = 60;
  const main = new UnderwaterPass(64, 36, 0);
  const effects = new WaterEffects('low', main.depthTexture, main.cameraUniforms);
  const optics = waterOptics(resolveConditions({ ...DEFAULT_CONDITIONS, visibility }));
  effects.setWater(optics);
  const world = {
    scene: new Scene(),
    effects,
    silt,
    waterOptics: optics,
    panelDraws: 0,
    preparePanel: () => {},
  } as unknown as World;
  const rovRoot = new Object3D();
  rovRoot.position.set(0, GROUND + 1.2, 0);
  const eye = new Object3D();
  eye.position.set(1, 0, 0);
  rovRoot.add(eye);
  rovRoot.updateMatrixWorld(true);
  const env: PanelEnv = {
    world,
    dt: 1 / 30,
    time: 1,
    rovRoot,
    eye,
    headingRad: 0,
    tmsMount: null,
    terrainHeight: () => GROUND,
    fxFor: () => DEFAULT_CAMERA_FX,
    whiteBalance: () => 1,
    observer: () => {},
    ambient: new Vector3(0.01, 0.02, 0.03),
    lightLevel: 0.8,
    seabedBase: -GROUND,
  };
  // Every kind of panel: main window panel 1 (MSAA pass), secondary panels and a monitor-window panel.
  const panels: { rig: CameraRig; pass: UnderwaterPass; source: ViewSource }[] = [{ rig: new CameraRig(1), pass: main, source: 'operational' }];
  for (const [src, msaa] of [
    ['external', 0],
    ['auxiliary', 0],
    ['external', 2],
  ] as const) {
    const v = new SecondaryView(src, undefined, msaa);
    panels.push({ rig: v.rig, pass: v.ensurePass(32, 18), source: src });
  }
  panels[0].rig.setMode('operational');
  const drawAll = (renderer = fakeRenderer()) => {
    for (const p of panels) renderCameraPanel(renderer as unknown as WebGLRenderer, p.rig, p.pass, p.source, { x: 0, y: 0, w: 64, h: 36 }, 64, 36, env);
    return renderer;
  };
  const stir = (seconds: number, amount: number) => {
    for (let i = 0; i < seconds * 30; i++) cloud.step(1 / 30, amount > 0 ? { amount, x: 0, y: GROUND + 1.2, z: 0 } : null, (_p, o) => o.set(0.1, 0, 0));
    world.effects.setSiltPuffs(cloud.allViews(24), silt.albedo);
  };
  return { cloud, silt, world, panels, drawAll, stir, optics };
}

const U = (p: UnderwaterPass) => p.waterUniforms as Record<string, { value: unknown }>;

describe('every camera panel renders the same water (renderCameraPanel)', () => {
  it('sets the sediment cloud (silt uniforms) on EVERY pass, not only panel 1', () => {
    const h = harness();
    h.drawAll();
    for (const p of h.panels) expect(p.pass.siltPuffCount).toBe(0); // nothing stirred yet
    h.stir(3, 1);
    expect(h.cloud.count).toBeGreaterThan(0);
    const r = h.drawAll();
    expect(h.world.panelDraws).toBe(8);
    expect(r.draws).toBeGreaterThanOrEqual(h.panels.length * 2);
    const totalMass = h.cloud.totalMass;
    for (const p of h.panels) {
      const u = U(p.pass);
      expect(p.pass.siltPuffCount).toBeGreaterThan(0);
      // Same cloud in every panel: the bound puffs carry the whole optical mass.
      let mass = 0;
      const P = u.uSiltP.value as Vector4[];
      const D = u.uSiltD.value as number[];
      for (let i = 0; i < p.pass.siltPuffCount; i++) mass += D[i] * Math.pow(Math.PI, 1.5) * P[i].w ** 3;
      expect(mass).toBeCloseTo(totalMass, 4);
      // Same global water and lamps.
      expect((u.uExt.value as Vector3).toArray()).toEqual(h.optics.ext);
      expect((u.uLampP.value as Vector4[])[0].w).toBe(60);
      expect((u.uLampP.value as Vector4[])[2].w).toBe(0);
    }
    // The particle silt (shared effects) follows the same puffs.
    expect(h.world.effects.siltCount).toBeGreaterThan(0);
  });

  it('the cloud disappears from every panel once it has settled', () => {
    const h = harness('turbid');
    h.stir(2, 0.8);
    h.drawAll();
    expect(h.panels.every((p) => p.pass.siltPuffCount > 0)).toBe(true);
    h.stir(400, 0);
    h.drawAll();
    expect(h.cloud.count).toBe(0);
    for (const p of h.panels) expect(p.pass.siltPuffCount).toBe(0);
    expect(h.world.effects.siltCount).toBe(0);
  });

  it('water detail limits the puffs per camera; particle density multiplier scales marine snow', () => {
    const h = harness();
    for (let i = 0; i < 120; i++) h.cloud.step(1 / 30, { amount: 1, x: i * 0.08, y: GROUND + 1, z: 0 }, null);
    h.silt.maxPuffs = 2;
    h.drawAll();
    for (const p of h.panels) expect(p.pass.siltPuffCount).toBeLessThanOrEqual(2);
    const fx = h.world.effects;
    const n1 = fx.snowCount;
    fx.setParticleDensity(2);
    expect(fx.snowCount).toBeGreaterThan(n1);
    fx.setParticleDensity(0);
    expect(fx.snowCount).toBe(0);
  });
});
