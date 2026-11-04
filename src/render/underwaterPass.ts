import {
  Camera,
  Color,
  DepthTexture,
  HalfFloatType,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { OPTICS } from './optics';

/**
 * Full-screen composite that turns the clean scene render into an
 * underwater image: per-channel extinction and in-scattering as a function of
 * the per-pixel viewing distance (reconstructed from the depth buffer), the
 * depth of the water column, plus camera artefacts (vignette, sensor noise,
 * lens droplets when crossing the surface).
 */
export class UnderwaterPass {
  readonly target: WebGLRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly quad: Mesh;
  private readonly scene = new Scene();
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly invProj = new Matrix4();

  constructor(width: number, height: number, samples: number) {
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      samples,
      depthBuffer: true,
    });
    this.target.depthTexture = new DepthTexture(width, height, UnsignedIntType);

    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uInvProj: { value: new Matrix4() },
        uCamWorld: { value: new Matrix4() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uCamDepth: { value: 0 },
        uUnderwater: { value: 1 },
        uExt: { value: new Vector3(...OPTICS.extinction) },
        uKd: { value: new Vector3(...OPTICS.kd) },
        uScatter: { value: OPTICS.scatterColor.clone() },
        uSeabedDepth: { value: 120 },
        uTurbidity: { value: OPTICS.turbidityNearBottom },
        uTime: { value: 0 },
        uNoise: { value: 0.02 },
        uVignette: { value: 0.35 },
        uWet: { value: 0 },
        uWhiteBalance: { value: 1 },
        uRes: { value: new Vector2(width, height) },
        uAirFog: { value: new Color(0.62, 0.71, 0.78) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform float uCamDepth;
        uniform float uUnderwater;
        uniform vec3 uExt;
        uniform vec3 uKd;
        uniform vec3 uScatter;
        uniform float uSeabedDepth;
        uniform float uTurbidity;
        uniform float uTime;
        uniform float uNoise;
        uniform float uVignette;
        uniform float uWet;
        uniform float uWhiteBalance;
        uniform vec2 uRes;
        uniform vec3 uAirFog;
        varying vec2 vUv;

        float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

        void main() {
          vec2 uv = vUv;
          // Lens droplets after crossing the surface.
          if (uWet > 0.0) {
            vec2 g = floor(uv * vec2(14.0, 9.0));
            float h = hash(g);
            vec2 f = fract(uv * vec2(14.0, 9.0)) - 0.5;
            float drop = smoothstep(0.35, 0.0, length(f + vec2(0.0, uTime * 0.25 * h - floor(uTime * 0.25 * h)) - 0.2));
            uv += f * drop * 0.06 * uWet * step(0.55, h);
          }
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
            // Camera white balance tuned for the vehicle lamps at ~2.5 m
            // (subsea cameras are balanced for their own lighting).
            vec3 wb = exp((uExt - vec3(uExt.b)) * 2.5);
            col *= mix(vec3(1.0), wb / max(max(wb.r, wb.g), wb.b) * 1.6, uWhiteBalance);
          } else {
            // Light atmospheric haze above water.
            float f = 1.0 - exp(-max(dist - 50.0, 0.0) * 0.0018);
            if (!sky) col = mix(col, uAirFog, f);
          }

          // Camera artefacts: vignette + sensor noise.
          vec2 c = vUv - 0.5;
          float vig = 1.0 - uVignette * dot(c, c) * 2.2;
          col *= vig;
          float n = hash(floor(vUv * uRes) + floor(fract(uTime * 7.0) * 113.0) * 17.0) - 0.5;
          col += n * uNoise * (0.4 + col);
          gl_FragColor = vec4(max(col, 0.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get depthTexture(): DepthTexture {
    return this.target.depthTexture!;
  }

  setSize(w: number, h: number): void {
    this.target.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
  }

  setNoise(noise: number, vignette: number): void {
    this.material.uniforms.uNoise.value = noise;
    this.material.uniforms.uVignette.value = vignette;
  }

  update(camera: PerspectiveCamera, params: { camDepth: number; seabedDepth: number; time: number; wet: number; whiteBalance?: number }): void {
    const u = this.material.uniforms;
    this.invProj.copy(camera.projectionMatrixInverse);
    u.uInvProj.value.copy(this.invProj);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uCamDepth.value = Math.max(0, params.camDepth);
    u.uUnderwater.value = params.camDepth > 0 ? 1 : 0;
    u.uSeabedDepth.value = params.seabedDepth;
    u.uTime.value = params.time;
    u.uWet.value = params.wet;
    u.uWhiteBalance.value = params.whiteBalance ?? 0;
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.ortho);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
