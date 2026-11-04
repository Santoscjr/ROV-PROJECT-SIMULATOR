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
import type { EnvironmentConditions } from '../sim/conditions';
import { terrainHeight } from '../sim/terrain';
import { createRovModel, type RovModel } from './rovModel';
import { createSeabed, type Cullable } from './seabed';
import { createStructures } from './structures';
import { createContext } from './context';
import { createSeaSurface, createSky, createVessel, type VesselRig } from './surface';
import { sunTransmission, waterOptics, type WaterOptics } from './optics';
import { WaterEffects } from './effects';
import type { UnderwaterPass } from './underwaterPass';

const LAMP_ANGLE = (36 * Math.PI) / 180;
/** Luminous intensity of each lamp at 100 % (cd, scene units). */
const LAMP_CD = 55;
/** Contrast threshold for the visibility culling (fraction of the blue/green transmission). */
const CULL_LN = 5.3;

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
  private readonly sky: ReturnType<typeof createSky>;
  /** Visualisation aid: soft light carried by the external (observer) camera. */
  readonly observerLight: PointLight;
  private readonly tether: Mesh;
  private readonly tetherMat = new MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
  private readonly envTex: Texture;
  private readonly tmpColor = new Color();
  private tetherTimer = 0;
  private readonly cullables: Cullable[];
  private optics: WaterOptics = waterOptics(null);
  // Sediment plume state (smoothed from the disturbance input).
  private disturbance = 0;
  private readonly disturbancePos = new Vector3();
  private plume = 0;
  private readonly plumePos = new Vector3(0, -1000, 0);
  private plumeAge = 0;
  private lastTime = -1;
  private readonly siltColor = new Color();

  constructor(
    readonly renderer: WebGLRenderer,
    readonly quality: GraphicsQuality,
    private readonly pass: UnderwaterPass,
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
    const seabed = createSeabed(quality);
    this.scene.add(seabed.group);
    this.cullables = seabed.cullables;
    this.scene.add(createStructures(quality));
    this.scene.add(createContext(quality));

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
      // Wide penumbra: LED arrays have a soft-edged beam.
      const l = new SpotLight(0xf3f0e8, 0, 0, LAMP_ANGLE, 0.7, 2);
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
        // Lamp light is negligible beyond ~15 m in the water: a short shadow
        // frustum culls distant casters from the shadow pass.
        l.shadow.camera.far = 18;
        l.shadow.bias = -0.0004;
        l.shadow.normalBias = 0.02;
      }
      this.lamps.push(l);
    });

    this.tether = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(), new Vector3(0, 1, 0)]), 4, 0.03, 5), this.tetherMat);
    this.tether.frustumCulled = false;
    this.tether.castShadow = quality !== 'low';
    this.scene.add(this.tether);

    this.effects = new WaterEffects(quality, pass.depthTexture, pass.cameraUniforms);
    this.effects.attachLights(this.lamps, this.rov.lightMounts, quality !== 'low');
    this.applyOptics();
  }

  /**
   * Environmental conditions → optics of the whole frame: water extinction and
   * veil (composite, particles, beams, plume), particle density, near-bottom
   * turbidity, surface irradiance (sun, sky, in-scatter) and the sea state.
   */
  setConditions(c: EnvironmentConditions): void {
    this.optics = waterOptics(c);
    this.applyOptics();
  }

  private applyOptics(): void {
    const o = this.optics;
    this.pass.setWater(o);
    this.effects.setWater(o);
    const su = this.sea.material.uniforms;
    // Shader amplitudes are tuned for the calm reference sea (Hs 0.6 m, T 6 s).
    su.uAmp.value = Math.max(0.2, o.waveHeight / 0.6);
    su.uSpeed.value = 6 / Math.max(2, o.wavePeriod);
    su.uIrr.value = o.irradiance;
    su.uOvercast.value = o.overcast;
    const ku = this.sky.material.uniforms;
    ku.uIrr.value = o.irradiance;
    ku.uOvercast.value = o.overcast;
  }

  /** Sediment stirred up by thrusters / contact (0..1) at `position` (the vehicle). */
  setSeabedDisturbance(amount: number, position: Vector3): void {
    this.disturbance = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
    const g = terrainHeight(position.x, position.z);
    this.disturbancePos.set(position.x, g + 0.25, position.z);
    this.effects.setSeabedDisturbance(this.disturbance, this.disturbancePos);
  }

  /** Update lighting for the depth of the vehicle / camera. */
  updateEnvironment(opts: { rovDepth: number; camDepth: number; time: number; camPos: Vector3; lightLevel: number }): Vector3 {
    const o = this.optics;
    const d = Math.max(0, opts.rovDepth);
    const tr = sunTransmission(d, this.tmpColor, o.extraKd);
    const above = opts.camDepth <= 0 && d <= 0.5;
    const irr = o.irradiance;
    // Sunlight reaching the vehicle depth, tinted by spectral absorption.
    // Overcast: weaker and mostly diffuse (flat light); night: essentially none.
    const k = above ? 1 : 0.85;
    this.sun.color.setRGB(tr.r, tr.g, tr.b);
    this.sun.intensity = 2.6 * k * irr * (1 - 0.8 * o.overcast);
    this.sun.visible = this.sun.intensity > 1e-3;
    this.hemi.color.setRGB(0.75 * tr.r, 0.84 * tr.g, 0.9 * tr.b);
    this.hemi.groundColor.setRGB(0.25 * tr.r, 0.31 * tr.g, 0.35 * tr.b);
    this.hemi.intensity = (above ? 0.9 : 0.75) * irr * (1 + 0.7 * o.overcast);
    this.scene.environmentIntensity = Math.max(0.03 * Math.min(1, irr * 4), 0.6 * (tr.g + tr.b) * 0.5 * irr);
    this.sky.visible = opts.camDepth <= 0;
    this.sea.material.uniforms.uTime.value = opts.time;
    this.sea.material.uniforms.uCamPos.value.copy(opts.camPos);

    const lamp = opts.lightLevel;
    for (const l of this.lamps) {
      l.intensity = LAMP_CD * lamp;
      l.visible = lamp > 0;
    }
    this.rov.setLightLevel(lamp);

    this.cull(opts.camPos);
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, opts.time - this.lastTime));
    this.lastTime = opts.time;
    this.updatePlume(dt, tr);

    // Ambient level for the particles (in-scattered sunlight).
    const veil = irr * (1 + 2.2 * o.extraTurbidity);
    return new Vector3(0.16 * tr.r * veil, 0.42 * tr.g * veil, 0.52 * tr.b * veil);
  }

  /** Hide seabed tiles / rock groups beyond what the water lets the camera see. */
  private cull(cam: Vector3): void {
    const o = this.optics;
    const minExt = Math.min(o.ext[1], o.ext[2]);
    const range = CULL_LN / Math.max(minExt, 1e-3) + 4;
    const under = cam.y < 0.5;
    for (const c of this.cullables) c.object.visible = under && c.box.distanceToPoint(cam) < range;
  }

  /** Smoothed sediment cloud for the composite (local extinction + in-scatter). */
  private updatePlume(dt: number, sunTr: Color): void {
    const target = this.disturbance;
    // Builds up within ~1.5 s, settles over ~10 s.
    const tau = target > this.plume ? 1.5 : 10;
    this.plume += (target - this.plume) * (1 - Math.exp(-dt / tau));
    if (target > 0.02) {
      if (this.plumePos.y < -900) this.plumePos.copy(this.disturbancePos);
      this.plumePos.lerp(this.disturbancePos, 1 - Math.exp(-dt / 2.5));
      this.plumeAge = 0;
    } else this.plumeAge += dt;
    if (this.plume < 0.005) {
      this.pass.setSilt(this.plumePos, 1, 0, this.siltColor.setRGB(0, 0, 0));
      return;
    }
    const radius = 1.2 + 2.2 * this.plume + Math.min(3, this.plumeAge * 0.25);
    const center = this.tmpCenter.copy(this.plumePos).add(this.tmpOff.set(0, 0.3 + this.plume * 0.5, 0));
    // In-scatter of the cloud: water ambient + lamp light reaching it.
    const o = this.optics;
    const amb = o.scatter;
    const e = Math.exp(-o.kd[2] * Math.max(0, -center.y));
    let lamp = 0;
    for (const l of this.lamps) {
      if (!l.visible) continue;
      l.getWorldPosition(this.tmpL);
      const dist = Math.max(0.8, this.tmpL.distanceTo(center));
      lamp += (l.intensity * Math.exp(-o.ext[1] * dist)) / (dist * dist);
    }
    lamp *= 0.035;
    this.siltColor.setRGB(
      0.55 * (amb.r * e * 0.6 + lamp * 0.95 + sunTr.r * 0.01),
      0.52 * (amb.g * e * 0.6 + lamp),
      0.44 * (amb.b * e * 0.6 + lamp * 1.02),
    );
    this.pass.setSilt(center, radius, 0.55 * this.plume, this.siltColor);
  }

  private readonly tmpCenter = new Vector3();
  private readonly tmpOff = new Vector3();
  private readonly tmpL = new Vector3();

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
