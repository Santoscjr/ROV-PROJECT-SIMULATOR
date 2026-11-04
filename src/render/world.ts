import {
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PMREMGenerator,
  PointLight,
  Scene,
  SpotLight,
  TubeGeometry,
  Vector3,
  type WebGLRenderer,
  type Texture,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GraphicsQuality } from '../config/settings';
import { createRovModel, type RovModel } from './rovModel';
import { createSeabed } from './seabed';
import { createStructures } from './structures';
import { createSeaSurface, createSky, createVessel, type VesselRig } from './surface';
import { sunTransmission } from './optics';
import { WaterEffects } from './effects';
import type { UnderwaterPass } from './underwaterPass';

const LAMP_ANGLE = (34 * Math.PI) / 180;
/** Luminous intensity of each lamp at 100 % (cd, scene units). */
const LAMP_CD = 55;

/**
 * Everything that is drawn. Rebuilt when the graphics quality changes; the
 * simulation state lives elsewhere and is unaffected.
 */
export class World {
  readonly scene = new Scene();
  readonly rov: RovModel;
  readonly vessel: VesselRig;
  readonly sea: ReturnType<typeof createSeaSurface>;
  readonly lamps: SpotLight[] = [];
  readonly effects: WaterEffects;
  private readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly sky: Mesh;
  /** Visualisation aid: soft light carried by the external (observer) camera. */
  readonly observerLight: PointLight;
  private readonly tether: Mesh;
  private readonly tetherMat = new MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
  private readonly envTex: Texture;
  private readonly tmpColor = new Color();
  private tetherTimer = 0;

  constructor(
    readonly renderer: WebGLRenderer,
    readonly quality: GraphicsQuality,
    pass: UnderwaterPass,
  ) {
    const pmrem = new PMREMGenerator(renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envTex;

    this.sky = createSky();
    this.scene.add(this.sky);
    this.sea = createSeaSurface();
    this.scene.add(this.sea);
    this.vessel = createVessel();
    this.scene.add(this.vessel.group);
    this.scene.add(createSeabed(quality));
    this.scene.add(createStructures(quality));

    this.sun = new DirectionalLight(0xffffff, 2.6);
    this.sun.position.set(40, 60, -50);
    this.scene.add(this.sun);
    this.hemi = new HemisphereLight(0xbfd6e6, 0x40505a, 0.8);
    this.scene.add(this.hemi);

    this.observerLight = new PointLight(0xdfe9ef, 0, 40, 1.2);
    this.scene.add(this.observerLight);

    this.rov = createRovModel({ quality });
    this.scene.add(this.rov.root);

    const shadowLamps = quality === 'high' ? 2 : quality === 'medium' ? 1 : 0;
    this.rov.lightMounts.forEach((mount, i) => {
      const l = new SpotLight(0xf3f0e8, 0, 0, LAMP_ANGLE, 0.55, 2);
      const target = new Object3D();
      target.position.set(10, 0, 0);
      mount.add(target);
      mount.add(l);
      l.position.set(0.05, 0, 0);
      l.target = target;
      if (i < shadowLamps) {
        l.castShadow = true;
        l.shadow.mapSize.set(quality === 'high' ? 1024 : 512, quality === 'high' ? 1024 : 512);
        l.shadow.camera.near = 0.3;
        l.shadow.camera.far = 40;
        l.shadow.bias = -0.0004;
        l.shadow.normalBias = 0.02;
      }
      this.lamps.push(l);
    });

    this.tether = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(), new Vector3(0, 1, 0)]), 4, 0.03, 5), this.tetherMat);
    this.tether.frustumCulled = false;
    this.tether.castShadow = quality !== 'low';
    this.scene.add(this.tether);

    this.effects = new WaterEffects(quality, pass.depthTexture);
    this.effects.attachLights(this.lamps, this.rov.lightMounts, quality !== 'low');
  }

  /** Update lighting for the depth of the vehicle / camera. */
  updateEnvironment(opts: { rovDepth: number; camDepth: number; time: number; camPos: Vector3; lightLevel: number }): Vector3 {
    const d = Math.max(0, opts.rovDepth);
    const tr = sunTransmission(d, this.tmpColor);
    const above = opts.camDepth <= 0 && d <= 0.5;
    // Sunlight reaching the vehicle depth, tinted by spectral absorption.
    const k = above ? 1 : 0.85;
    this.sun.color.setRGB(tr.r, tr.g, tr.b);
    this.sun.intensity = 2.6 * k;
    this.hemi.color.setRGB(0.75 * tr.r, 0.84 * tr.g, 0.9 * tr.b);
    this.hemi.groundColor.setRGB(0.25 * tr.r, 0.31 * tr.g, 0.35 * tr.b);
    this.hemi.intensity = above ? 0.9 : 0.75;
    this.scene.environmentIntensity = Math.max(0.03, 0.6 * (tr.g + tr.b) * 0.5);
    this.sky.visible = opts.camDepth <= 0;
    this.sea.material.uniforms.uTime.value = opts.time;
    this.sea.material.uniforms.uCamPos.value.copy(opts.camPos);

    const lamp = opts.lightLevel;
    for (const l of this.lamps) {
      l.intensity = LAMP_CD * lamp;
      l.visible = lamp > 0;
    }
    this.rov.setLightLevel(lamp);
    // Ambient level for the particles (in-scattered sunlight).
    return new Vector3(0.16 * tr.r, 0.42 * tr.g, 0.52 * tr.b);
  }

  /** Umbilical from the vessel's launch point to the vehicle, sagging with the current. */
  updateTether(dt: number, from: Vector3 | null, current: Vector3): void {
    this.tetherTimer -= dt;
    if (!from) {
      this.tether.visible = false;
      return;
    }
    this.tether.visible = true;
    if (this.tetherTimer > 0) return;
    this.tetherTimer = 1 / 20;
    const end = this.rov.tetherPoint.getWorldPosition(new Vector3());
    const pts: Vector3[] = [];
    const n = 14;
    const span = from.distanceTo(end);
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const p = new Vector3().lerpVectors(from, end, s);
      // Bow with the current and slight catenary sag.
      const bow = Math.sin(s * Math.PI) * Math.min(25, span * 0.18);
      p.addScaledVector(current, bow * 3);
      p.y -= Math.sin(s * Math.PI) * Math.min(6, span * 0.05);
      pts.push(p);
    }
    // Keep the near end straight out of the termination.
    pts.splice(n, 0, end.clone().add(new Vector3(0, 1.2, 0)));
    this.tether.geometry.dispose();
    this.tether.geometry = new TubeGeometry(new CatmullRomCurve3(pts), 80, 0.03, 5);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) (mat as MeshStandardMaterial).dispose?.();
    });
    this.lamps.forEach((l) => l.shadow?.map?.dispose());
    this.rov.dispose();
    this.effects.dispose();
    this.envTex.dispose();
  }
}
