import {
  CanvasTexture,
  Color,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type MeshStandardMaterialParameters,
  type Texture,
} from 'three';

/**
 * Shared GLSL value-noise used for world-space detail (marine growth,
 * sediment) so large merged meshes need no UV unwrapping.
 */
const NOISE_GLSL = /* glsl */ `
  float wHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float wNoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(wHash(i), wHash(i + vec3(1,0,0)), f.x), mix(wHash(i + vec3(0,1,0)), wHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(wHash(i + vec3(0,0,1)), wHash(i + vec3(1,0,1)), f.x), mix(wHash(i + vec3(0,1,1)), wHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float wFbm(vec3 p) { return 0.5 * wNoise(p) + 0.25 * wNoise(p * 2.03) + 0.125 * wNoise(p * 4.1) + 0.0625 * wNoise(p * 8.3); }
`;

export interface FoulingOptions {
  /** 0 = clean, 1 = heavy marine growth. */
  amount: number;
  /** Colour of the growth/sediment. */
  growth?: Color;
  /** Sediment settles on upward-facing surfaces. */
  sediment?: number;
  scale?: number;
}

/**
 * MeshStandardMaterial with procedural world-space marine growth: dark
 * patchy fouling, rust-brown streaks, and silt on upward-facing surfaces.
 */
export function fouledMaterial(params: MeshStandardMaterialParameters, f: FoulingOptions): MeshStandardMaterial {
  const m = new MeshStandardMaterial(params);
  const growth = f.growth ?? new Color(0.24, 0.26, 0.18);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFoul = { value: f.amount };
    shader.uniforms.uGrowth = { value: growth };
    shader.uniforms.uSediment = { value: f.sediment ?? 0.5 };
    shader.uniforms.uFoulScale = { value: f.scale ?? 1.6 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform float uFoul;\nuniform vec3 uGrowth;\nuniform float uSediment;\nuniform float uFoulScale;\n${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 p = vWPos * uFoulScale;
          float n = wFbm(p);
          float patches = smoothstep(0.45, 0.75, n) * uFoul;
          float streak = smoothstep(0.6, 0.9, wNoise(vec3(p.x * 3.0, p.y * 0.4, p.z * 3.0))) * uFoul * 0.6;
          diffuseColor.rgb = mix(diffuseColor.rgb, uGrowth, patches * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.18, 0.10), streak * 0.5);
          float up = smoothstep(0.55, 0.95, vWNormal.y);
          float silt = up * uSediment * (0.6 + 0.4 * wNoise(p * 3.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.40, 0.33), silt);
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = min(1.0, roughnessFactor + uFoul * 0.25);',
      );
  };
  m.customProgramCacheKey = () => `fouled-${f.amount}-${f.sediment ?? 0.5}`;
  return m;
}

/** Procedural sand/silt texture (colour + bump) drawn on a canvas. */
export function makeSandTextures(size = 512): { map: Texture; bump: Texture } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const b = document.createElement('canvas');
  b.width = b.height = size;
  const bctx = b.getContext('2d')!;
  const bimg = bctx.createImageData(size, size);
  // Tileable noise by summing periodic sines + hashed grains.
  const rnd = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      const ripple = Math.sin(u * 6 + Math.sin(v * 2) * 1.4) * 0.5 + 0.5;
      const blot =
        (Math.sin(u * 2 + 1.3) * Math.cos(v * 3 + 0.4) + Math.sin(u * 5 + v * 4) * 0.5 + Math.cos(u * 9 - v * 7) * 0.25) * 0.25 + 0.5;
      const grain = rnd(x, y);
      const val = 0.55 + ripple * 0.12 + blot * 0.22 + (grain - 0.5) * 0.22;
      const i = (y * size + x) * 4;
      const shell = grain > 0.995 ? 0.35 : 0;
      img.data[i] = Math.min(255, (0.62 * val + shell) * 255);
      img.data[i + 1] = Math.min(255, (0.58 * val + shell) * 255);
      img.data[i + 2] = Math.min(255, (0.47 * val + shell * 0.9) * 255);
      img.data[i + 3] = 255;
      const h = ripple * 0.6 + grain * 0.4;
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = h * 255;
      bimg.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  const bump = new CanvasTexture(b);
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
  }
  return { map, bump };
}

/** A small label texture (e.g. inspection tags, vessel name). */
export function makeLabelTexture(
  text: string,
  opts: { bg?: string; fg?: string; w?: number; h?: number; font?: string; stripes?: boolean } = {},
): CanvasTexture {
  const w = opts.w ?? 256;
  const h = opts.h ?? 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = opts.bg ?? '#e8b320';
  ctx.fillRect(0, 0, w, h);
  if (opts.stripes) {
    ctx.fillStyle = '#111';
    for (let x = -h; x < w; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + 14, h);
      ctx.lineTo(x + 14 + h * 0.25, h * 0.75);
      ctx.lineTo(x + h * 0.25, h * 0.75);
      ctx.fill();
    }
  }
  ctx.strokeStyle = opts.fg ?? '#111';
  ctx.lineWidth = Math.max(3, h * 0.04);
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
  ctx.fillStyle = opts.fg ?? '#111';
  ctx.font = opts.font ?? `bold ${Math.round(h * 0.45)}px "IBM Plex Sans", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h * (opts.stripes ? 0.4 : 0.52));
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
