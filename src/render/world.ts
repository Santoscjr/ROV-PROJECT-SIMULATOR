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

/**
 * Front lighting = 2 directional "spot" lamps (upper pair: long throw on the
 * work target, the only ones that may cast shadows) + 2 wide "flood" lamps
 * (lower pair: splayed and slightly down to fill the near field and seabed).
 * Order: upper-port, upper-stbd, lower-port, lower-stbd.
 */
const LAMPS = [
  { angle: 32, penumbra: 0.6, splay: 9, down: 0, cd: 75 },
  { angle: 32, penumbra: 0.6, splay: -9, down: 0, cd: 75 },
  { angle: 62, penumbra: 0.85, splay: 30, down: -10, cd: 42 },
  { angle: 62, penumbra: 0.85, splay: -30, down: -10, cd: 42 },
] as const;
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
  /** Tether jacket: yellow polyurethane (common on work-class tethers), same diameter as the physics. */
  private readonly tetherMat = new MeshStandardMaterial({ color: 0xd9a42a, roughness: 0.5, metalness: 0 });
  /** Front-lamp multiplier (settings → lighting.front). */
  frontGain = 1;
  private readonly envTex: Texture;
  private readonly tmpColor = new Color();
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
      const spec = LAMPS[i] ?? LAMPS[2];
      mount.rotateY((spec.splay * Math.PI) / 180);
      mount.rotateZ((spec.down * Math.PI) / 180);
      // Soft-edged LED beam (penumbra).
      const l = new SpotLight(0xf3f0e8, 0, 0, (spec.angle * Math.PI) / 180, spec.penumbra, 2);
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

    this.tether = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(), new Vector3(0, 1, 0)]), 4, 0.03, 8), this.tetherMat);
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
    const g = terrainHeight(position.x, position.z);
    // Safety: nothing is stirred up from high above the seabed.
    const fade = Math.min(1, Math.max(0, (8 - (position.y - g)) / 2));
    this.disturbance = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0)) * fade;
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
    this.lamps.forEach((l, i) => {
      l.intensity = (LAMPS[i] ?? LAMPS[2]).cd * lamp * this.frontGain;
      l.visible = lamp > 0;
    });
    this.rov.setLightLevel(lamp);

    this.cull(opts.camPos);
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, opts.time - this.lastTime));
    this.lastTime = opts.time;
    this.updatePlume(dt);

    // Ambient level for the particles (in-scattered sunlight).
    const veil = irr * (1 + 2.2 * o.extraTurbidity);
    return new Vector3(0.16 * tr.r * veil, 0.42 * tr.g * veil, 0.52 * tr.b * veil);
  }

  /**
   * Per-panel scene preparation (called before each camera panel is drawn, in
   * any window): sky only above the surface and visibility culling from THAT
   * camera — so a view never depends on which panel is the "main" one.
   */
  preparePanel(camPos: Vector3): void {
    this.sky.visible = camPos.y >= 0;
    this.cull(camPos);
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
  private updatePlume(dt: number): void {
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
    const radius = 0.8 + 1.6 * this.plume + Math.min(2, this.plumeAge * 0.2);
    const center = this.tmpCenter.copy(this.plumePos).add(this.tmpOff.set(0, 0.1 + this.plume * 0.4, 0));
    // In-scatter of the cloud: water ambient + lamp light reaching it, seen
    // through ~1.5 m of water (the composite's white balance then applies).
    const o = this.optics;
    const amb = o.scatter;
    const e = Math.exp(-o.kd[2] * Math.max(0, -center.y));
    let lamp = 0;
    for (const l of this.lamps) {
      if (!l.visible) continue;
      l.getWorldPosition(this.tmpL);
      const dist = Math.max(1, this.tmpL.distanceTo(center));
      // Mostly spill light: the cloud sits below/around the beams.
      lamp += (l.intensity * Math.exp(-o.ext[1] * dist)) / (dist * dist);
    }
    lamp *= 0.006;
    const path = 1.5;
    this.siltColor.setRGB(
      0.5 * (amb.r * e * 0.6 + lamp) * Math.exp(-o.ext[0] * path),
      0.47 * (amb.g * e * 0.6 + lamp) * Math.exp(-o.ext[1] * path),
      0.4 * (amb.b * e * 0.6 + lamp) * Math.exp(-o.ext[2] * path),
    );
    this.pass.setSilt(center, radius, 0.6 * this.plume, this.siltColor);
  }

  private readonly tmpCenter = new Vector3();
  private readonly tmpOff = new Vector3();
  private readonly tmpL = new Vector3();

  /**
   * Umbilical drawn along the shape computed by the physics tether model
   * (anchor → vehicle). The last point is snapped to the visual termination
   * with a short straight run out of the bend restrictor.
   */
  /**
   * Tether drawn EXACTLY through the physical nodes (TMS exit → ROV termination
   * at `rov.tetherAttach`; the last ~0.4 m runs inside the bend restrictor, as
   * on the real vehicle). Rebuilt every frame so the picture never lags or
   * contradicts the simulation.
   */
  updateTether(_dt: number, path: readonly Vector3[] | null): void {
    if (!path || path.length < 2) {
      this.tether.visible = false;
      return;
    }
    this.tether.visible = true;
    this.tether.geometry.dispose();
    this.tether.geometry = new TubeGeometry(new CatmullRomCurve3(path as Vector3[], false, 'centripetal'), Math.max(40, path.length * 4), 0.03, 8);
  }

  /** Camera panels drawn with the full water pipeline (composite + particles/beams) since the last reset — diagnostics/tests. */
  panelDraws = 0;

  /** Water optics of the current conditions (shared by every camera, panel and window). */
  get waterOptics(): WaterOptics {
    return this.optics;
  }

  /** Optional assisted visibility of the tether (non-physical glow, clearly a display aid). */
  setTetherAssist(on: boolean): void {
    this.tetherMat.emissive.setHex(on ? 0x8a6a10 : 0x000000);
    this.tetherMat.emissiveIntensity = on ? 0.6 : 0;
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
