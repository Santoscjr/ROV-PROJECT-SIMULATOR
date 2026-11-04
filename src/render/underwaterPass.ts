import {
  Camera,
  Color,
  DepthTexture,
  FloatType,
  HalfFloatType,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { CameraFx } from '../config/settings';
import { OPTICS, waterOptics, type WaterOptics } from './optics';
import { CAMERA_GLSL, createCameraUniforms, type CameraUniforms } from './lens';

/** Metering grid (samples) used for auto exposure. */
const METER_W = 24;
const METER_H = 14;
/** Adaptation time constant of the auto exposure (s). */
const ADAPT_TAU = 0.7;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * Water model shared by the composite and the metering pass: radiance that
 * reaches the camera for a given (rectilinear) screen uv, before exposure.
 */
const WATER_GLSL = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform float uCamDepth;
  uniform float uUnderwater;
  uniform vec3 uExt;
  uniform vec3 uExtWB;
  uniform vec3 uKd;
  uniform vec3 uScatter;
  uniform float uSeabedDepth;
  uniform float uTurbidity;
  uniform float uWhiteBalance;
  uniform vec3 uAirFog;
  uniform vec4 uSilt;        // xyz centre, w radius
  uniform float uSiltDensity; // 1/m at the centre
  uniform vec3 uSiltColor;    // in-scattered radiance of the plume

  vec3 sceneRadiance(vec2 uv) {
    vec3 col = texture2D(tColor, uv).rgb;
    float z = texture2D(tDepth, uv).r;
    vec4 ndc = vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
    vec4 vp = uInvProj * ndc;
    vp /= vp.w;
    bool sky = z >= 0.99999;
    float dist = sky ? 1e4 : length(vp.xyz);
    vec3 dirView = normalize(vp.xyz);
    vec3 dirWorld = normalize((uCamWorld * vec4(dirView, 0.0)).xyz);
    vec3 wpos = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;

    if (uUnderwater > 0.5) {
      // In-scattered (sun-derived) radiance seen along this direction: looking
      // up sees the brighter water above, looking down the darker column below.
      float upw = clamp(dirWorld.y, -1.0, 1.0);
      float effDepth = max(0.0, uCamDepth - 14.0 * max(upw, 0.0) + 30.0 * max(-upw, 0.0));
      vec3 ambient = uScatter * exp(-uKd * effDepth);
      ambient *= 0.75 + 0.5 * smoothstep(-0.6, 0.9, upw);
      float pDepth = sky ? uSeabedDepth : clamp(-wpos.y, 0.0, uSeabedDepth);
      // Extra turbidity near the bottom.
      float nearBottom = smoothstep(18.0, 0.0, uSeabedDepth - max(uCamDepth, pDepth));
      vec3 ext = uExt + vec3(uTurbidity * nearBottom);
      vec3 T = exp(-ext * min(dist, 400.0));
      col = col * T + ambient * (1.0 - T);
      // Local sediment plume: Gaussian blob, optical depth integrated along
      // the ray up to the visible surface (soft everywhere, no hard edge).
      if (uSiltDensity > 0.0) {
        vec3 camPos = uCamWorld[3].xyz;
        vec3 oc = camPos - uSilt.xyz;
        float tc = -dot(oc, dirWorld);
        float d2 = max(dot(oc, oc) - tc * tc, 0.0);
        float sig = uSilt.w * 0.6;
        float frac = smoothstep(tc - 1.6 * sig, tc + 1.6 * sig, min(dist, 400.0)) - smoothstep(tc - 1.6 * sig, tc + 1.6 * sig, 0.0);
        float od = uSiltDensity * 1.77 * sig * exp(-d2 / (sig * sig)) * frac;
        vec3 Ts = exp(-od * vec3(0.9, 1.0, 1.12));
        col = col * Ts + uSiltColor * (1.0 - Ts);
      }
      // Camera white balance tuned for the vehicle lamps at ~2.5 m
      // (subsea cameras are balanced for their own lighting).
      vec3 wb = exp((uExtWB - vec3(uExtWB.b)) * 2.5);
      col *= mix(vec3(1.0), wb / max(max(wb.r, wb.g), wb.b) * 1.6, uWhiteBalance);
    } else {
      // Light atmospheric haze above water.
      float f = 1.0 - exp(-max(dist - 50.0, 0.0) * 0.0018);
      if (!sky) col = mix(col, uAirFog, f);
    }
    return max(col, 0.0);
  }
`;

/**
 * Full-screen composite that turns the clean scene render into an
 * underwater image: per-channel extinction and in-scattering as a function of
 * the per-pixel viewing distance (reconstructed from the depth buffer), the
 * depth of the water column, a local sediment plume, then the camera:
 * lens distortion, auto exposure, contrast, vignette, sensor noise and lens
 * droplets when crossing the surface.
 */
export class UnderwaterPass {
  readonly target: WebGLRenderTarget;
  /** Uniforms of the camera model, shared with the effects drawn after the composite. */
  readonly cameraUniforms: CameraUniforms = createCameraUniforms();
  private readonly material: ShaderMaterial;
  private readonly adaptMat: ShaderMaterial;
  private readonly adaptTargets: [WebGLRenderTarget, WebGLRenderTarget];
  private adaptIndex = 0;
  private readonly quad: Mesh;
  private readonly scene = new Scene();
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lastTime = -1;
  private adaptReset = true;
  private autoExposure = false;
  private water: WaterOptics = waterOptics(null);

  constructor(width: number, height: number, samples: number) {
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      samples,
      depthBuffer: true,
    });
    this.target.depthTexture = new DepthTexture(width, height, UnsignedIntType);

    const small = { type: FloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter } as const;
    this.adaptTargets = [new WebGLRenderTarget(1, 1, small), new WebGLRenderTarget(1, 1, small)];
    this.cameraUniforms.tExposure.value = this.adaptTargets[0].texture;

    const waterUniforms = {
      tColor: { value: this.target.texture },
      tDepth: { value: this.target.depthTexture },
      uInvProj: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uCamDepth: { value: 0 },
      uUnderwater: { value: 1 },
      uExt: { value: new Vector3(...OPTICS.extinction) },
      uExtWB: { value: new Vector3(...OPTICS.extinction) },
      uKd: { value: new Vector3(...OPTICS.kd) },
      uScatter: { value: OPTICS.scatterColor.clone() },
      uSeabedDepth: { value: 120 },
      uTurbidity: { value: OPTICS.turbidityNearBottom },
      uWhiteBalance: { value: 1 },
      uAirFog: { value: new Color(0.62, 0.71, 0.78) },
      uSilt: { value: new Vector4(0, -1000, 0, 1) },
      uSiltDensity: { value: 0 },
      uSiltColor: { value: new Color() },
    };

    this.material = new ShaderMaterial({
      uniforms: {
        ...waterUniforms,
        ...this.cameraUniforms,
        uTime: { value: 0 },
        uNoise: { value: 0.02 },
        uVignette: { value: 0.35 },
        uContrast: { value: 1 },
        uWet: { value: 0 },
        uRes: { value: new Vector2(width, height) },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${WATER_GLSL}
        ${CAMERA_GLSL}
        uniform float uTime;
        uniform float uNoise;
        uniform float uVignette;
        uniform float uContrast;
        uniform float uWet;
        uniform vec2 uRes;
        varying vec2 vUv;

        float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

        void main() {
          vec2 uv = lensSourceUV(vUv);
          // Lens droplets after crossing the surface.
          if (uWet > 0.0) {
            vec2 g = floor(uv * vec2(14.0, 9.0));
            float h = hash(g);
            vec2 f = fract(uv * vec2(14.0, 9.0)) - 0.5;
            float drop = smoothstep(0.35, 0.0, length(f + vec2(0.0, uTime * 0.25 * h - floor(uTime * 0.25 * h)) - 0.2));
            uv += f * drop * 0.06 * uWet * step(0.55, h);
          }
          vec3 col = sceneRadiance(uv) * cameraExposure();

          // Camera artefacts: vignette (optical, before the sensor) + sensor noise.
          vec2 c = vUv - 0.5;
          float vig = 1.0 - uVignette * dot(c, c) * 2.2;
          col *= vig;
          float n = hash(floor(vUv * uRes) + floor(fract(uTime * 7.0) * 113.0) * 17.0) - 0.5;
          col += n * uNoise * (0.4 + col);
          gl_FragColor = vec4(max(col, 0.0), 1.0);
          #include <tonemapping_fragment>
          // Contrast about mid-grey in display-referred space (linear values here).
          vec3 dr = pow(max(gl_FragColor.rgb, 0.0), vec3(1.0 / 2.2));
          dr = clamp((dr - 0.42) * uContrast + 0.42, 0.0, 1.0);
          gl_FragColor.rgb = pow(dr, vec3(2.2));
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });

    // Metering + adaptation in one 1×1 pass: centre-weighted mean log-luminance
    // of the composite on a coarse grid, blended with the previous value.
    this.adaptMat = new ShaderMaterial({
      uniforms: { ...waterUniforms, tPrev: { value: null }, uBlend: { value: 1 } },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${WATER_GLSL}
        uniform sampler2D tPrev;
        uniform float uBlend;
        void main() {
          float sum = 0.0;
          float wsum = 0.0;
          for (int y = 0; y < ${METER_H}; y++) {
            for (int x = 0; x < ${METER_W}; x++) {
              vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(${METER_W.toFixed(1)}, ${METER_H.toFixed(1)});
              vec2 p = uv - 0.5;
              float w = 1.0 - 1.2 * dot(p, p);
              vec3 c = sceneRadiance(uv);
              float l = dot(min(c, vec3(20.0)), vec3(0.2126, 0.7152, 0.0722));
              sum += log(l + 1e-3) * w;
              wsum += w;
            }
          }
          float cur = sum / wsum;
          float prev = texture2D(tPrev, vec2(0.5)).r;
          gl_FragColor = vec4(mix(prev, cur, uBlend), 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.setAspect(width, height);
  }

  get depthTexture(): DepthTexture {
    return this.target.depthTexture!;
  }

  setSize(w: number, h: number): void {
    this.target.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
    this.setAspect(w, h);
  }

  private setAspect(w: number, h: number): void {
    const a = w / Math.max(1, h);
    this.cameraUniforms.uAspect.value = a;
    this.cameraUniforms.uLensRc2.value = 0.25 * (a * a + 1);
  }

  /** Legacy v1 control (noise amplitude and vignette strength in shader units). */
  setNoise(noise: number, vignette: number): void {
    this.material.uniforms.uNoise.value = noise;
    this.material.uniforms.uVignette.value = vignette;
  }

  /**
   * Camera image processing. The operational (pilot) camera gets the full
   * model (wide-angle barrel distortion, sensor noise, vignette); the
   * external observer camera a milder one (no distortion, low noise).
   */
  setCameraFx(fx: CameraFx, operational: boolean): void {
    const u = this.material.uniforms;
    const cu = this.cameraUniforms;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    cu.uDistort.value = operational ? clamp(fx.distortion, 0, 1) * 0.3 : 0;
    u.uNoise.value = clamp(fx.noise, 0, 1) * (operational ? 0.0875 : 0.03);
    u.uVignette.value = clamp(fx.vignette, 0, 1) * (operational ? 1.1 : 0.5);
    u.uContrast.value = clamp(fx.contrast, 0.6, 1.5);
    const auto = fx.autoExposure;
    if (auto && !this.autoExposure) this.adaptReset = true;
    this.autoExposure = auto;
    cu.uExposure.value.x = auto ? 1 : 0;
    cu.uExposure.value.y = Math.pow(2, clamp(fx.exposureBias, -2, 2));
  }

  /** Jump the auto exposure to the current scene (after a teleport / camera switch). */
  resetAdaptation(): void {
    this.adaptReset = true;
  }

  /** Water optics from the environmental conditions (see World.setConditions). */
  setWater(w: WaterOptics): void {
    this.water = w;
    const u = this.material.uniforms;
    u.uExt.value.set(...w.ext);
    u.uKd.value.set(...w.kd);
    (u.uScatter.value as Color).copy(w.scatter);
    u.uTurbidity.value = w.nearBottom;
    // Above-water haze follows the sky brightness (grey overcast, dark at night).
    const sky = (1 - w.overcast) + w.overcast * w.irradiance * 1.6 + 0.004;
    (u.uAirFog.value as Color).setRGB(0.62, 0.71, 0.78).lerp(new Color(0.6, 0.62, 0.64), w.overcast).multiplyScalar(sky);
  }

  /** Local sediment plume (density 0 disables it). */
  setSilt(center: Vector3, radius: number, density: number, color: Color): void {
    const u = this.material.uniforms;
    (u.uSilt.value as Vector4).set(center.x, center.y, center.z, Math.max(0.1, radius));
    u.uSiltDensity.value = density;
    (u.uSiltColor.value as Color).copy(color);
  }

  get optics(): WaterOptics {
    return this.water;
  }

  update(camera: PerspectiveCamera, params: { camDepth: number; seabedDepth: number; time: number; wet: number; whiteBalance?: number }): void {
    const u = this.material.uniforms;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamDepth.value = Math.max(0, params.camDepth);
    u.uUnderwater.value = params.camDepth > 0 ? 1 : 0;
    u.uSeabedDepth.value = params.seabedDepth;
    u.uTime.value = params.time;
    u.uWet.value = params.wet;
    u.uWhiteBalance.value = params.whiteBalance ?? 0;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, params.time - this.lastTime));
    this.lastTime = params.time;
    this.adaptMat.uniforms.uBlend.value = this.adaptReset ? 1 : 1 - Math.exp(-dt / ADAPT_TAU);
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    if (this.autoExposure) {
      const prev = this.adaptTargets[this.adaptIndex];
      this.adaptIndex = 1 - this.adaptIndex;
      const next = this.adaptTargets[this.adaptIndex];
      this.adaptMat.uniforms.tPrev.value = prev.texture;
      this.quad.material = this.adaptMat;
      renderer.setRenderTarget(next);
      renderer.render(this.scene, this.ortho);
      this.cameraUniforms.tExposure.value = next.texture;
      this.adaptReset = false;
      this.quad.material = this.material;
    }
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.ortho);
  }

  /** Debug/test helper: current auto-exposure gain (reads back 1 pixel; not for per-frame use). */
  readExposure(renderer: WebGLRenderer): { logLum: number; gain: number } {
    const buf = new Float32Array(4);
    renderer.readRenderTargetPixels(this.adaptTargets[this.adaptIndex], 0, 0, 1, 1, buf);
    const e = this.cameraUniforms.uExposure.value;
    const r = this.cameraUniforms.uExpRange.value;
    const gain = Math.min(r.y, Math.max(r.x, Math.pow(e.z / Math.exp(buf[0]), r.z)));
    return { logLum: buf[0], gain: (this.autoExposure ? gain : 1) * e.y };
  }

  dispose(): void {
    this.target.dispose();
    this.adaptTargets.forEach((t) => t.dispose());
    this.material.dispose();
    this.adaptMat.dispose();
    this.quad.geometry.dispose();
  }
}
