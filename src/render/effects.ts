import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CustomBlending,
  Group,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type DepthTexture,
  type Object3D,
  type PerspectiveCamera,
  type SpotLight,
} from 'three';
import { OPTICS, waterOptics, type WaterOptics } from './optics';
import type { PuffView } from '../sim/sedimentCloud';
import { CAMERA_GLSL, type CameraUniforms } from './lens';
import type { GraphicsQuality } from '../config/settings';

const MAX_LIGHTS = 4;
/** Length of the beam volumes (m); beyond this the lamp light is negligible in the water. */
const BEAM_LEN = 13;
/** Reference particle count per quality at density 1; the buffer holds the maximum density. */
const SNOW: Record<GraphicsQuality, number> = { low: 1800, medium: 4500, high: 9000 };
const MAX_DENSITY = 2.4;
/** Silt sprites per puff of the resuspended cloud (×MAX_PUFFS sprites in all). */
const SILT_PER_PUFF: Record<GraphicsQuality, number> = { low: 6, medium: 12, high: 18 };
/** Puffs of the sediment cloud drawn as sprites (= SedimentCloud default pool). */
const MAX_PUFFS = 24;

const DEPTH_GLSL = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform vec2 uRes;
  uniform vec2 uOrigin;
  uniform float uNear;
  uniform float uFar;
  // Scene depth behind this fragment (the scene was rendered rectilinear).
  float sceneViewDepthAt(vec2 suv) {
    float z = texture2D(tDepth, suv).r;
    return -perspectiveDepthToViewZ(z, uNear, uFar);
  }
  float sceneViewDepth() { return sceneViewDepthAt(lensSourceUV((gl_FragCoord.xy - uOrigin) / uRes)); }
`;

const LIGHTS_GLSL = /* glsl */ `
  uniform vec3 uLPos[${MAX_LIGHTS}];
  uniform vec3 uLDir[${MAX_LIGHTS}];
  uniform float uLCos[${MAX_LIGHTS}];
  uniform float uLInt[${MAX_LIGHTS}];
  uniform vec3 uExt;
  // Lamp light at p. 'spill' is the fraction reaching outside the cone
  // (light scattered by the water around the beam).
  vec3 artificialS(vec3 p, float spill) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      vec3 d = p - uLPos[i];
      float dist = length(d);
      float c = dot(d / max(dist, 1e-3), uLDir[i]);
      float cone = mix(spill, 1.0, smoothstep(uLCos[i], uLCos[i] + 0.12, c));
      sum += uLInt[i] * cone * exp(-uExt * dist) / (dist * dist + 0.6);
    }
    return sum;
  }
  vec3 artificial(vec3 p) { return artificialS(p, 0.0); }
`;

/**
 * Effects composited after the underwater pass, occluded against the scene
 * depth buffer: suspended particles ("marine snow"), light-beam backscatter
 * from the ROV lamps (single-scattering ray march through each lamp cone)
 * and the sediment plume stirred up near the seabed. They compute their own
 * water attenuation and follow the camera model (lens distortion, exposure).
 */
export class WaterEffects {
  readonly scene = new Scene();
  private readonly particles: Points;
  private readonly pMat: ShaderMaterial;
  private readonly beamMats: ShaderMaterial[] = [];
  private readonly beams: Mesh[] = [];
  private readonly lights: SpotLight[] = [];
  private readonly shared: Record<string, { value: unknown }>;
  private readonly snowBase: number;
  private readonly snowMax: number;
  // Silt sprites: a fixed set per puff of the sediment cloud (World.sediment),
  // positioned on the GPU from the puff uniforms — same cloud in every panel.
  private readonly silt: Points;
  private readonly siltMat: ShaderMaterial;
  private readonly siltPerPuff: number;
  private siltDetail = 1;
  private siltPuffs = 0;
  private water: WaterOptics = waterOptics(null);
  private densityMul = 1;
  private lastTime = -1;
  constructor(quality: GraphicsQuality, depthTexture: DepthTexture, camera: CameraUniforms) {
    this.snowBase = SNOW[quality];
    this.snowMax = Math.round(this.snowBase * MAX_DENSITY);
    // Own uniform objects for the camera/lens terms: values are copied from the
    // pass of the panel being drawn (bindPass), so every panel/window gets the
    // same particles and beams with ITS depth buffer, lens and exposure.
    const cam: Record<string, { value: unknown }> = {};
    for (const [k, u] of Object.entries(camera as unknown as Record<string, { value: unknown }>)) cam[k] = { value: u.value };
    this.shared = {
      ...cam,
      tDepth: { value: depthTexture },
      uRes: { value: new Vector2(1, 1) },
      uOrigin: { value: new Vector2(0, 0) },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uLPos: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector3()) },
      uLDir: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector3(1, 0, 0)) },
      uLCos: { value: new Array(MAX_LIGHTS).fill(0.9) },
      uLInt: { value: new Array(MAX_LIGHTS).fill(0) },
      uExt: { value: new Vector3(...OPTICS.extinction) },
      uAmbient: { value: new Vector3(0.1, 0.2, 0.25) },
      uTime: { value: 0 },
      uCamPos: { value: new Vector3() },
      uPixelRatio: { value: 1 },
      uProjScale: { value: 1 },
      uInvProj: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uScattering: { value: 1 },
      uSnowBright: { value: 1 },
    };

    // --- Marine snow: fixed buffer, drawn count follows the particle density ---
    const size = 22;
    const count = this.snowMax;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * size;
      pos[i * 3 + 1] = Math.random() * size;
      pos[i * 3 + 2] = Math.random() * size;
      seed[i] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('seed', new BufferAttribute(seed, 1));
    geo.setDrawRange(0, this.snowBase);
    this.pMat = new ShaderMaterial({
      uniforms: { ...this.shared, uBox: { value: size } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        ${CAMERA_GLSL}
        attribute float seed;
        uniform float uTime;
        uniform float uBox;
        uniform vec3 uCamPos;
        uniform float uPixelRatio;
        varying float vSeed;
        varying vec3 vWorld;
        varying float vDist;
        varying float vFloc;
        void main() {
          vec3 drift = vec3(sin(uTime * 0.2 + seed * 40.0) * 0.15, -0.03 - seed * 0.04, cos(uTime * 0.17 + seed * 30.0) * 0.15) * uTime;
          vec3 p = mod(position + drift - uCamPos + uBox * 0.5, uBox) - uBox * 0.5 + uCamPos;
          vWorld = p;
          vSeed = seed;
          // A few large aggregates ("flocs") among fine dust.
          vFloc = step(0.965, fract(seed * 37.0));
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDist = -mv.z;
          gl_Position = lensClip(projectionMatrix * mv);
          float sz = mix(0.45 + seed * 1.5, 3.2 + seed * 2.0, vFloc);
          gl_PointSize = clamp(sz * uPixelRatio * 26.0 / max(vDist, 0.3), 1.0, mix(9.0, 22.0, vFloc) * uPixelRatio);
        }`,
      fragmentShader: /* glsl */ `
        ${CAMERA_GLSL}
        ${DEPTH_GLSL}
        ${LIGHTS_GLSL}
        uniform vec3 uAmbient;
        uniform float uSnowBright;
        varying float vSeed;
        varying vec3 vWorld;
        varying float vDist;
        varying float vFloc;
        void main() {
          if (vDist > sceneViewDepth()) discard;
          vec2 c = gl_PointCoord - 0.5;
          // Flocs are irregular, fluffy blobs; dust is a soft dot.
          float ang = atan(c.y, c.x);
          float rr = 0.25 * (1.0 - vFloc * 0.35 * (0.5 + 0.5 * sin(ang * 3.0 + vSeed * 20.0)));
          float r = dot(c, c);
          if (r > rr) discard;
          float soft = 1.0 - r / rr;
          soft *= mix(1.0, 0.45 * soft, vFloc);
          vec3 light = artificial(vWorld) * 0.9 + uAmbient * 0.35;
          vec3 col = light * exp(-uExt * vDist) * soft * (0.35 + vSeed * 0.65) * uSnowBright;
          gl_FragColor = vec4(col * cameraExposure(), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.particles = new Points(geo, this.pMat);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    // --- Silt: sprites scattered (Gaussian) inside each puff of the cloud ---
    this.siltPerPuff = SILT_PER_PUFF[quality];
    const nSilt = this.siltPerPuff * MAX_PUFFS;
    const sPuff = new Float32Array(nSilt);
    const sSlot = new Float32Array(nSilt);
    const sOff = new Float32Array(nSilt * 3);
    const sSeed = new Float32Array(nSilt);
    // Deterministic layout (no per-frame CPU work): Box–Muller from a hash.
    const h = (n: number) => {
      const x = Math.sin(n * 91.345 + 47.853) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let i = 0; i < nSilt; i++) {
      sPuff[i] = Math.floor(i / this.siltPerPuff);
      sSlot[i] = i % this.siltPerPuff;
      for (let k = 0; k < 3; k++) {
        const u1 = Math.max(1e-4, h(i * 7 + k * 2 + 1));
        const u2 = h(i * 7 + k * 2 + 2);
        sOff[i * 3 + k] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * Math.SQRT1_2;
      }
      sSeed[i] = h(i * 7 + 13);
    }
    const sGeo = new BufferGeometry();
    sGeo.setAttribute('position', new BufferAttribute(sOff, 3));
    sGeo.setAttribute('puff', new BufferAttribute(sPuff, 1));
    sGeo.setAttribute('slot', new BufferAttribute(sSlot, 1));
    sGeo.setAttribute('seed', new BufferAttribute(sSeed, 1));
    sGeo.setDrawRange(0, 0);
    this.siltMat = new ShaderMaterial({
      uniforms: {
        ...this.shared,
        uPuffP: { value: Array.from({ length: MAX_PUFFS }, () => new Vector4(0, -1000, 0, 1)) },
        uPuffD: { value: Array.from({ length: MAX_PUFFS }, () => new Vector4()) },
        uSiltAlbedo: { value: new Vector3(0.5, 0.48, 0.4) },
        uPerPuff: { value: this.siltPerPuff },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        ${CAMERA_GLSL}
        attribute float puff;
        attribute float slot;
        attribute float seed;
        uniform float uPerPuff;
        uniform vec4 uPuffP[${MAX_PUFFS}];  // centre, sigma
        uniform vec4 uPuffD[${MAX_PUFFS}];  // peak extinction (1/m), age (s)
        uniform float uTime;
        uniform float uProjScale;
        varying vec3 vWorld;
        varying float vDist;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          int i = int(puff + 0.5);
          vec4 P = uPuffP[i];
          vec4 D = uPuffD[i];
          vSeed = seed;
          if (D.x <= 0.0 || slot >= uPerPuff) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
          float sig = P.w;
          // Slow internal turbulence (eddies of the size of the puff).
          float t = uTime * (0.18 + 0.12 * seed) + seed * 37.0;
          vec3 sw = vec3(sin(t + seed * 6.0), 0.45 * sin(t * 0.7 + seed * 11.0), cos(t * 0.9 + seed * 3.0)) * 0.22;
          vec3 p = P.xyz + (position + sw) * sig * 0.8;
          p.y = max(p.y, P.y - 0.3 * sig);
          vWorld = p;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDist = -mv.z;
          gl_Position = lensClip(projectionMatrix * mv);
          // Fewer sprites (lower detail) are drawn larger to cover the same volume.
          float worldSize = sig * (0.8 + 0.7 * seed) * pow(${this.siltPerPuff.toFixed(1)} / max(uPerPuff, 1.0), 0.33);
          gl_PointSize = clamp(worldSize * uProjScale / max(vDist, 0.2), 1.0, 400.0);
          // Opacity from the local density through the sprite (texture over the
          // composite, which already applies the cloud's extinction).
          float rho = D.x * exp(-dot(position, position) * 0.64);
          vAlpha = clamp(1.0 - exp(-rho * worldSize * 0.45), 0.0, 0.5) * smoothstep(0.0, 0.5, D.y);
        }`,
      fragmentShader: /* glsl */ `
        ${CAMERA_GLSL}
        ${DEPTH_GLSL}
        ${LIGHTS_GLSL}
        uniform vec3 uAmbient;
        uniform vec3 uSiltAlbedo;
        varying vec3 vWorld;
        varying float vDist;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          if (vAlpha <= 0.002) discard;
          float sceneZ = sceneViewDepth();
          if (vDist > sceneZ + 0.3) discard;
          vec2 c = gl_PointCoord - 0.5;
          float r = dot(c, c) * 4.0;
          if (r > 1.0) discard;
          // Lumpy, soft-edged puff; fades where it meets the seabed/structures.
          float lump = 0.8 + 0.2 * sin(c.x * 9.0 + vSeed * 31.0) * sin(c.y * 8.0 - vSeed * 17.0);
          float a = vAlpha * pow(1.0 - r, 1.8) * lump * clamp((sceneZ - vDist + 0.3) / 0.8, 0.0, 1.0);
          vec3 light = artificialS(vWorld, 0.1) * 0.32 + uAmbient * 0.5;
          vec3 col = uSiltAlbedo * light * exp(-uExt * vDist) * cameraExposure();
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor = vec4(gl_FragColor.rgb * a, a);
        }`,
    });
    this.silt = new Points(sGeo, this.siltMat);
    this.silt.frustumCulled = false;
    this.silt.renderOrder = -1;
    this.scene.add(this.silt);
  }

  /** Register the ROV lamps (beam volumes follow them). */
  attachLights(lights: SpotLight[], mounts: Object3D[], beams: boolean): void {
    this.lights.splice(0, this.lights.length, ...lights.slice(0, MAX_LIGHTS));
    void mounts;
    if (!beams) return;
    for (const light of this.lights) {
      const len = BEAM_LEN;
      // Slightly oversized proxy: the exact cone is intersected per pixel.
      const radius = Math.tan(light.angle) * len * 1.2;
      const geo = new ConeGeometry(radius, len, 20, 1, false);
      geo.translate(0, -len / 2, 0); // apex at origin, opening along -Y
      geo.rotateZ(Math.PI / 2); // opening along +X
      geo.translate(-0.3, 0, 0);
      const mat = this.makeBeamMaterial();
      const m = new Mesh(geo, mat);
      m.frustumCulled = false;
      this.beams.push(m);
      this.beamMats.push(mat);
      this.scene.add(m);
    }
  }

  private makeBeamMaterial(): ShaderMaterial {
    return new ShaderMaterial({
      uniforms: {
        ...this.shared,
        uBPos: { value: new Vector3() },
        uBDir: { value: new Vector3(1, 0, 0) },
        uBCos: { value: new Vector2(0.8, 0.9) },
        uBInt: { value: 0 },
        uBLen: { value: BEAM_LEN },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: BackSide,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        ${CAMERA_GLSL}
        void main() {
          gl_Position = lensClip(projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0));
        }`,
      fragmentShader: /* glsl */ `
        ${CAMERA_GLSL}
        ${DEPTH_GLSL}
        uniform vec3 uExt;
        uniform vec3 uCamPos;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform float uTime;
        uniform float uScattering;
        uniform vec3 uBPos;
        uniform vec3 uBDir;
        uniform vec2 uBCos;   // outer, inner cosine
        uniform float uBInt;
        uniform float uBLen;

        float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

        float coneF(vec3 co, vec3 rd, float t) {
          vec3 q = co + rd * t;
          float h = dot(q, uBDir);
          return h * h - dot(q, q) * uBCos.x * uBCos.x;
        }
        bool insideAt(vec3 co, vec3 rd, float t) {
          vec3 q = co + rd * t;
          return dot(q, uBDir) > 0.0 && coneF(co, rd, t) > 0.0;
        }

        void main() {
          vec2 suv = lensSourceUV((gl_FragCoord.xy - uOrigin) / uRes);
          vec4 vp = uInvProj * vec4(suv * 2.0 - 1.0, 1.0, 1.0);
          vec3 rdV = normalize(vp.xyz / vp.w);
          vec3 rd = normalize((uCamWorld * vec4(rdV, 0.0)).xyz);
          float tScene = sceneViewDepthAt(suv) / max(-rdV.z, 1e-3);

          // Ray segment inside the finite cone: slab along the axis, then the quadric.
          vec3 co = uCamPos - uBPos;
          float dv = dot(rd, uBDir);
          float cv = dot(co, uBDir);
          float t0 = 0.0;
          float t1 = min(tScene, 60.0);
          if (abs(dv) > 1e-5) {
            float ta = -cv / dv;
            float tb = (uBLen - cv) / dv;
            t0 = max(t0, min(ta, tb));
            t1 = min(t1, max(ta, tb));
          } else if (cv < 0.0 || cv > uBLen) discard;
          if (t1 <= t0) discard;
          float cc = uBCos.x * uBCos.x;
          float a = dv * dv - cc;
          float b = 2.0 * (dv * cv - dot(rd, co) * cc);
          float c = cv * cv - dot(co, co) * cc;
          float disc = b * b - 4.0 * a * c;
          float s0 = t0, s1 = t1;
          if (disc > 0.0 && abs(a) > 1e-6) {
            float sq = sqrt(disc);
            float r1 = (-b - sq) / (2.0 * a);
            float r2 = (-b + sq) / (2.0 * a);
            float lo = min(r1, r2), hi = max(r1, r2);
            // Split [t0,t1] at the roots and keep the span of inside pieces.
            float p0 = t0, p1 = clamp(lo, t0, t1), p2 = clamp(hi, t0, t1), p3 = t1;
            bool i0 = p1 > p0 && insideAt(co, rd, 0.5 * (p0 + p1));
            bool i1 = p2 > p1 && insideAt(co, rd, 0.5 * (p1 + p2));
            bool i2 = p3 > p2 && insideAt(co, rd, 0.5 * (p2 + p3));
            if (!(i0 || i1 || i2)) discard;
            s0 = i0 ? p0 : (i1 ? p1 : p2);
            s1 = i2 ? p3 : (i1 ? p2 : p1);
          } else if (!insideAt(co, rd, 0.5 * (t0 + t1))) discard;
          if (s1 <= s0) discard;

          // Single scattering with equiangular sampling about the lamp (the
          // 1/r² peak is integrated exactly; little noise with few samples).
          const int N = 12;
          float D = -dot(co, rd);                     // closest approach to the lamp
          float hh = max(length(co + rd * D), 0.03);  // its distance
          float ta = atan((s0 - D) / hh);
          float tb = atan((s1 - D) / hh);
          // Interleaved gradient noise: low-discrepancy jitter, barely visible.
          float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec3 sum = vec3(0.0);
          for (int i = 0; i < N; i++) {
            float th = mix(ta, tb, (float(i) + j) / float(N));
            float t = D + hh * tan(th);
            vec3 q = co + rd * t;
            float dl = length(q);
            vec3 ldir = q / max(dl, 1e-3);
            float cone = smoothstep(uBCos.x, uBCos.y, dot(ldir, uBDir));
            // Henyey-Greenstein (g = 0.6) blended with isotropic: forward glow, some backscatter.
            float mu = dot(ldir, -rd);
            float g = 0.6;
            float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
            float phase = 0.35 + 0.65 * hg * 0.25;
            // Integrand cone·phase·T/(r²+0.25), divided by the pdf ∝ 1/r².
            sum += cone * phase * exp(-uExt * (dl + t)) * (dl * dl / (dl * dl + 0.25));
          }
          float dt = (tb - ta) / (hh * float(N));
          vec3 col = vec3(0.95, 0.97, 1.0) * sum * dt * uBInt * uScattering;
          gl_FragColor = vec4(col * cameraExposure(), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  /** Draw the next panel against this pass's depth buffer and camera/lens uniforms. */
  bindPass(depthTexture: DepthTexture, camera: CameraUniforms): void {
    this.shared.tDepth.value = depthTexture;
    for (const [k, u] of Object.entries(camera as unknown as Record<string, { value: unknown }>)) {
      const dst = this.shared[k];
      if (dst) dst.value = u.value;
    }
  }

  /** Water optics from the environmental conditions. */
  setWater(w: WaterOptics): void {
    this.water = w;
    (this.shared.uExt.value as Vector3).set(...w.ext);
    // Visual weight of the lamp haze grows a little faster than b (multiple scattering, veiling glare).
    this.shared.uScattering.value = Math.pow(w.scattering, 1.2);
    this.shared.uSnowBright.value = 0.85 + 0.15 * Math.min(2.5, w.scattering);
    this.applySnowCount();
  }

  /** Settings: marine snow density multiplier (0..2) on top of the water preset. */
  setParticleDensity(k: number): void {
    this.densityMul = Math.min(2, Math.max(0, Number.isFinite(k) ? k : 1));
    this.applySnowCount();
  }

  /** Marine snow particles drawn per panel (diagnostics). */
  get snowCount(): number {
    return this.particles.geometry.drawRange.count;
  }

  /** Silt sprites drawn per panel (diagnostics). */
  get siltCount(): number {
    return this.silt.geometry.drawRange.count;
  }

  private applySnowCount(): void {
    const n = Math.min(this.snowMax, Math.round(this.snowBase * this.water.particleDensity * this.densityMul));
    this.particles.geometry.setDrawRange(0, n);
  }

  /** Water detail: fraction (0..1] of the silt sprites per puff. */
  setSiltDetail(f: number): void {
    this.siltDetail = Math.min(1, Math.max(0.1, f));
    this.applySiltCount();
  }

  private applySiltCount(): void {
    const per = Math.max(1, Math.round(this.siltPerPuff * this.siltDetail));
    // Sprites are grouped by puff; with fewer per puff, keep the first `per` of each group.
    this.silt.geometry.setDrawRange(0, this.siltPuffs * this.siltPerPuff);
    this.siltMat.uniforms.uPerPuff.value = per;
  }

  /**
   * Puffs of the resuspended sediment cloud for this frame (World, once per
   * frame; every panel then draws the same cloud) and the particle albedo.
   */
  setSiltPuffs(puffs: readonly PuffView[], albedo: { r: number; g: number; b: number }): void {
    const u = this.siltMat.uniforms;
    const P = u.uPuffP.value as Vector4[];
    const D = u.uPuffD.value as Vector4[];
    const n = Math.min(MAX_PUFFS, puffs.length);
    for (let i = 0; i < MAX_PUFFS; i++) {
      const p = puffs[i];
      if (i < n && p) {
        P[i].set(p.x, p.y, p.z, Math.max(0.05, p.sigma));
        D[i].set(p.density, p.age, 0, 0);
      } else D[i].set(0, 0, 0, 0);
    }
    (u.uSiltAlbedo.value as Vector3).set(albedo.r, albedo.g, albedo.b);
    this.siltPuffs = n;
    this.applySiltCount();
  }

  private readonly tmp = new Vector3();
  private readonly tmpM = new Matrix4();

  update(
    camera: PerspectiveCamera,
    opts: { time: number; width: number; height: number; pixelRatio: number; ambient: Vector3; underwater: boolean; lightLevel: number; originX?: number; originY?: number },
  ): void {
    const s = this.shared;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, opts.time - this.lastTime));
    this.lastTime = opts.time;
    (s.uRes.value as Vector2).set(opts.width, opts.height);
    (s.uOrigin.value as Vector2).set(opts.originX ?? 0, opts.originY ?? 0);
    s.uNear.value = camera.near;
    s.uFar.value = camera.far;
    s.uTime.value = opts.time;
    s.uPixelRatio.value = opts.pixelRatio;
    // Pixels per metre at 1 m distance (for world-sized sprites).
    s.uProjScale.value = (opts.height * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    (s.uCamPos.value as Vector3).copy(camera.position);
    (s.uInvProj.value as Matrix4).copy(camera.projectionMatrixInverse);
    (s.uCamWorld.value as Matrix4).copy(camera.matrixWorld);
    (s.uAmbient.value as Vector3).copy(opts.ambient);
    const lp = s.uLPos.value as Vector3[];
    const ld = s.uLDir.value as Vector3[];
    const lc = s.uLCos.value as number[];
    const li = s.uLInt.value as number[];
    this.lights.forEach((l, i) => {
      l.getWorldPosition(lp[i]);
      l.target.getWorldPosition(this.tmp);
      ld[i].subVectors(this.tmp, lp[i]).normalize();
      lc[i] = Math.cos(l.angle);
      li[i] = l.visible ? l.intensity * 0.02 : 0;
      const beam = this.beams[i];
      if (beam) {
        beam.visible = l.visible && opts.underwater && l.intensity > 0;
        beam.position.copy(lp[i]);
        this.tmpM.lookAt(lp[i], this.tmp, camera.up);
        beam.quaternion.setFromRotationMatrix(this.tmpM);
        beam.rotateY(Math.PI / 2); // lookAt aims -Z; cone points +X
        beam.updateMatrixWorld();
        const u = this.beamMats[i].uniforms;
        (u.uBPos.value as Vector3).copy(lp[i]);
        (u.uBDir.value as Vector3).copy(ld[i]);
        (u.uBCos.value as Vector2).set(Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)));
        u.uBInt.value = l.intensity * 0.0013;
      }
    });
    this.particles.visible = opts.underwater;
    this.silt.visible = opts.underwater && this.siltPuffs > 0;
    void dt;
  }

  dispose(): void {
    this.particles.geometry.dispose();
    this.silt.geometry.dispose();
    this.pMat.dispose();
    this.siltMat.dispose();
    this.beamMats.forEach((m) => m.dispose());
    this.beams.forEach((b) => b.geometry.dispose());
  }
}

export function makeGroup(name: string): Group {
  const g = new Group();
  g.name = name;
  return g;
}
