import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  Group,
  Matrix4,
  Mesh,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type DepthTexture,
  type Object3D,
  type PerspectiveCamera,
  type SpotLight,
} from 'three';
import { OPTICS } from './optics';
import type { GraphicsQuality } from '../config/settings';

const MAX_LIGHTS = 4;

const DEPTH_GLSL = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform vec2 uRes;
  uniform float uNear;
  uniform float uFar;
  float sceneViewDepth() {
    float z = texture2D(tDepth, gl_FragCoord.xy / uRes).r;
    return -perspectiveDepthToViewZ(z, uNear, uFar);
  }
`;

const LIGHTS_GLSL = /* glsl */ `
  uniform vec3 uLPos[${MAX_LIGHTS}];
  uniform vec3 uLDir[${MAX_LIGHTS}];
  uniform float uLCos[${MAX_LIGHTS}];
  uniform float uLInt[${MAX_LIGHTS}];
  uniform vec3 uExt;
  vec3 artificial(vec3 p) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      vec3 d = p - uLPos[i];
      float dist = length(d);
      float c = dot(d / max(dist, 1e-3), uLDir[i]);
      float cone = smoothstep(uLCos[i], uLCos[i] + 0.12, c);
      sum += uLInt[i] * cone * exp(-uExt * dist) / (dist * dist + 0.6);
    }
    return sum;
  }
`;

/**
 * Effects composited after the underwater pass, occluded against the scene
 * depth buffer: suspended particles ("marine snow") and light-beam
 * backscatter from the ROV lamps. They compute their own water attenuation.
 */
export class WaterEffects {
  readonly scene = new Scene();
  private readonly particles: Points;
  private readonly pMat: ShaderMaterial;
  private readonly beamMat: ShaderMaterial;
  private readonly beams: Mesh[] = [];
  private readonly lights: SpotLight[] = [];
  private readonly shared: Record<string, { value: unknown }>;

  constructor(quality: GraphicsQuality, depthTexture: DepthTexture) {
    const count = { low: 1800, medium: 4500, high: 9000 }[quality];
    this.shared = {
      tDepth: { value: depthTexture },
      uRes: { value: new Vector2(1, 1) },
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
    };

    // --- Marine snow ---
    const size = 22;
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
    this.pMat = new ShaderMaterial({
      uniforms: { ...this.shared, uBox: { value: size } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float seed;
        uniform float uTime;
        uniform float uBox;
        uniform vec3 uCamPos;
        uniform float uPixelRatio;
        varying float vSeed;
        varying vec3 vWorld;
        varying float vDist;
        void main() {
          vec3 drift = vec3(sin(uTime * 0.2 + seed * 40.0) * 0.15, -0.03 - seed * 0.04, cos(uTime * 0.17 + seed * 30.0) * 0.15) * uTime;
          vec3 p = mod(position + drift - uCamPos + uBox * 0.5, uBox) - uBox * 0.5 + uCamPos;
          vWorld = p;
          vSeed = seed;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((0.6 + seed * 1.6) * uPixelRatio * 26.0 / max(vDist, 0.3), 1.0, 9.0 * uPixelRatio);
        }`,
      fragmentShader: /* glsl */ `
        ${DEPTH_GLSL}
        ${LIGHTS_GLSL}
        uniform vec3 uAmbient;
        varying float vSeed;
        varying vec3 vWorld;
        varying float vDist;
        void main() {
          if (vDist > sceneViewDepth()) discard;
          vec2 c = gl_PointCoord - 0.5;
          float r = dot(c, c);
          if (r > 0.25) discard;
          float soft = 1.0 - r * 4.0;
          vec3 light = artificial(vWorld) * 0.9 + uAmbient * 0.35;
          vec3 col = light * exp(-uExt * vDist) * soft * (0.35 + vSeed * 0.65);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.particles = new Points(geo, this.pMat);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    // --- Light beams (one cone per lamp) ---
    this.beamMat = new ShaderMaterial({
      uniforms: { ...this.shared, uIntensity: { value: 0 }, uLength: { value: 9 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying float vAlong;
        varying float vViewZ;
        uniform float uLength;
        void main() {
          vAlong = clamp(-position.y / uLength + 0.5, 0.0, 1.0);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 mv = viewMatrix * w;
          vViewZ = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${DEPTH_GLSL}
        uniform vec3 uExt;
        uniform vec3 uCamPos;
        uniform float uIntensity;
        uniform float uLength;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying float vAlong;
        varying float vViewZ;
        void main() {
          float sceneZ = sceneViewDepth();
          if (vViewZ > sceneZ) discard;
          float soft = clamp((sceneZ - vViewZ) / 1.5, 0.0, 1.0);
          vec3 v = normalize(uCamPos - vWorld);
          float edge = pow(abs(dot(normalize(vNormalW), v)), 1.6);
          float along = vAlong;
          float fall = exp(-along * uLength * 0.22) * smoothstep(0.0, 0.06, along);
          vec3 col = vec3(0.9, 0.95, 1.0) * uIntensity * edge * fall * soft;
          col *= exp(-uExt * (along * uLength * 0.5 + length(uCamPos - vWorld) * 0.5));
          gl_FragColor = vec4(col * 0.012, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  /** Register the ROV lamps (beam cones follow their mounts). */
  attachLights(lights: SpotLight[], mounts: Object3D[], beams: boolean): void {
    this.lights.splice(0, this.lights.length, ...lights.slice(0, MAX_LIGHTS));
    if (!beams) return;
    for (const light of this.lights) {
      const len = 9;
      const radius = Math.tan(light.angle) * len;
      const geo = new ConeGeometry(radius, len, 24, 1, true);
      // apex at origin pointing to +X
      geo.translate(0, -len / 2, 0);
      geo.rotateZ(Math.PI / 2);
      const m = new Mesh(geo, this.beamMat);
      m.frustumCulled = false;
      this.beams.push(m);
      this.scene.add(m);
    }
    void mounts;
  }

  private readonly tmp = new Vector3();
  private readonly tmpM = new Matrix4();

  update(
    camera: PerspectiveCamera,
    opts: { time: number; width: number; height: number; pixelRatio: number; ambient: Vector3; underwater: boolean; lightLevel: number },
  ): void {
    const s = this.shared;
    (s.uRes.value as Vector2).set(opts.width, opts.height);
    s.uNear.value = camera.near;
    s.uFar.value = camera.far;
    s.uTime.value = opts.time;
    s.uPixelRatio.value = opts.pixelRatio;
    (s.uCamPos.value as Vector3).copy(camera.position);
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
      }
    });
    this.beamMat.uniforms.uIntensity.value = opts.lightLevel;
    this.particles.visible = opts.underwater;
  }

  dispose(): void {
    this.particles.geometry.dispose();
    this.pMat.dispose();
    this.beamMat.dispose();
    this.beams.forEach((b) => b.geometry.dispose());
  }
}

export function makeGroup(name: string): Group {
  const g = new Group();
  g.name = name;
  return g;
}
