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
export const NOISE_GLSL = /* glsl */ `
  float wHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float wNoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(wHash(i), wHash(i + vec3(1,0,0)), f.x), mix(wHash(i + vec3(0,1,0)), wHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(wHash(i + vec3(0,0,1)), wHash(i + vec3(1,0,1)), f.x), mix(wHash(i + vec3(0,1,1)), wHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float wFbm(vec3 p) { return 0.5 * wNoise(p) + 0.25 * wNoise(p * 2.03) + 0.125 * wNoise(p * 4.1) + 0.0625 * wNoise(p * 8.3); }
`;

/**
 * GLSL: perturb a view-space normal by a height field given as screen-space
 * derivatives of a height in metres (Mikkelsen's surface-gradient bump,
 * unnormalised so procedural relief keeps its physical scale).
 */
export const PERTURB_GLSL = /* glsl */ `
  vec3 surfPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 sx = dFdx(surf_pos);
    vec3 sy = dFdy(surf_pos);
    vec3 r1 = cross(sy, surf_norm);
    vec3 r2 = cross(surf_norm, sx);
    float det = dot(sx, r1) * faceDir;
    vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
    return normalize(abs(det) * surf_norm - grad);
  }
`;

export interface FoulingOptions {
  /** 0 = clean, 1 = heavy marine growth. */
  amount: number;
  /** Colour of the growth/sediment. */
  growth?: Color;
  /** Sediment settles on upward-facing surfaces. */
  sediment?: number;
  scale?: number;
  /** Paint chipping (0–1): small spots where the coating is gone. */
  chips?: number;
  /** Micro relief of growth/corrosion read under the lamps at 1–5 m (0–1). */
  relief?: number;
}

/**
 * MeshStandardMaterial with procedural world-space marine growth: dark
 * patchy fouling, rust-brown streaks, chipped paint, silt on upward-facing
 * surfaces and a fine relief that catches the lamp light. Works with
 * instanced meshes and flat shading.
 */
export function fouledMaterial(params: MeshStandardMaterialParameters, f: FoulingOptions): MeshStandardMaterial {
  const m = new MeshStandardMaterial(params);
  const growth = f.growth ?? new Color(0.24, 0.26, 0.18);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFoul = { value: f.amount };
    shader.uniforms.uGrowth = { value: growth };
    shader.uniforms.uSediment = { value: f.sediment ?? 0.5 };
    shader.uniforms.uFoulScale = { value: f.scale ?? 1.6 };
    shader.uniforms.uChips = { value: f.chips ?? 0.3 };
    shader.uniforms.uRelief = { value: f.relief ?? 0.6 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 fwp = vec4(transformed, 1.0);
          vec3 fwn = objectNormal;
          #ifdef USE_INSTANCING
            fwp = instanceMatrix * fwp;
            fwn = mat3(instanceMatrix) * fwn;
          #endif
          vWPos = (modelMatrix * fwp).xyz;
          vWNormal = normalize(mat3(modelMatrix) * fwn);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform float uFoul;\nuniform vec3 uGrowth;\nuniform float uSediment;\nuniform float uFoulScale;\nuniform float uChips;\nuniform float uRelief;\n${NOISE_GLSL}\n${PERTURB_GLSL}\nfloat fRelief = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 p = vWPos * uFoulScale;
          #ifdef FLAT_SHADED
            vec3 wn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
          #else
            vec3 wn = normalize(vWNormal);
          #endif
          float n = wFbm(p);
          float patches = smoothstep(0.45, 0.75, n) * uFoul;
          float streak = smoothstep(0.6, 0.9, wNoise(vec3(p.x * 3.0, p.y * 0.4, p.z * 3.0))) * uFoul * 0.6;
          // Chipped coating: small sharp spots exposing dark primer / corroded steel.
          float chipN = wNoise(vWPos * 9.0 + 3.7);
          float chips = smoothstep(0.78, 0.84, chipN) * uChips;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.17, 0.14), chips * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, uGrowth, patches * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.18, 0.10), streak * 0.5);
          // Hydroid / encrusting specks on the growth.
          float speck = step(0.9, wHash(floor(vWPos * 40.0))) * patches;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.72, 0.62), speck * 0.5);
          float up = smoothstep(0.55, 0.95, wn.y);
          float silt = up * uSediment * (0.6 + 0.4 * wNoise(p * 3.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.40, 0.33), silt);
          float camD = length(vWPos - cameraPosition);
          fRelief = uRelief * (1.0 - smoothstep(2.5, 14.0, camD)) *
            (patches * 0.006 * wNoise(vWPos * 6.0) + (wNoise(vWPos * 22.0) - 0.5) * 0.0012 * (0.4 + patches) - chips * 0.0015 + silt * 0.002 * wNoise(vWPos * 12.0));
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (uRelief > 0.0) normal = surfPerturb(-vViewPosition, normal, vec2(dFdx(fRelief), dFdy(fRelief)), faceDirection);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = min(1.0, roughnessFactor + uFoul * 0.25);',
      );
  };
  m.customProgramCacheKey = () => `fouled2-${f.amount}-${f.sediment ?? 0.5}-${f.chips ?? 0.3}-${f.relief ?? 0.6}`;
  return m;
}

/** Tileable value noise on a `period`-cell lattice (for canvas textures). */
function tileNoise(seed: number) {
  const h = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return (x: number, y: number, period: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const m = (v: number) => ((v % period) + period) % period;
    const a = h(m(xi), m(yi));
    const b = h(m(xi + 1), m(yi));
    const c = h(m(xi), m(yi + 1));
    const d = h(m(xi + 1), m(yi + 1));
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/**
 * Procedural sand/silt texture (colour + bump) drawn on a canvas, tileable.
 * Fine quartz sand with silt patches, dark organic detritus and pale shell
 * fragments. Large-scale ripples are added in the terrain shader.
 */
export function makeSandTextures(size = 512): { map: Texture; bump: Texture } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const b = document.createElement('canvas');
  b.width = b.height = size;
  const bctx = b.getContext('2d')!;
  const bimg = bctx.createImageData(size, size);
  const n1 = tileNoise(1);
  const n2 = tileNoise(2);
  const n3 = tileNoise(3);
  const grainH = (x: number, y: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Multi-scale tileable noise: patches (4 cells), lumps (16), fine (64).
      const patch = n1(u * 4, v * 4, 4);
      const lump = n2(u * 16, v * 16, 16);
      const fine = n3(u * 64, v * 64, 64);
      const grain = grainH(x, y);
      const silt = Math.max(0, Math.min(1, (patch - 0.45) * 3));
      let val = 0.62 + (lump - 0.5) * 0.16 + (fine - 0.5) * 0.12 + (grain - 0.5) * 0.2;
      val *= 1 - silt * 0.12;
      let r = 0.64 * val;
      let g = 0.6 * val;
      let bl = 0.5 * val;
      // Organic detritus (dark) and shell fragments (pale).
      const sp = grainH(Math.floor(x / 2) + 911, Math.floor(y / 2) + 37);
      if (sp > 0.992) {
        r *= 0.55;
        g *= 0.55;
        bl *= 0.6;
      } else if (sp < 0.006) {
        r = Math.min(1, r + 0.3);
        g = Math.min(1, g + 0.28);
        bl = Math.min(1, bl + 0.25);
      }
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, r * 255);
      img.data[i + 1] = Math.min(255, g * 255);
      img.data[i + 2] = Math.min(255, bl * 255);
      img.data[i + 3] = 255;
      height[y * size + x] = lump * 0.45 + fine * 0.3 + grain * 0.25 - silt * 0.2 + (sp < 0.006 ? 0.3 : 0);
    }
  }
  for (let k = 0; k < size * size; k++) {
    const hv = Math.max(0, Math.min(1, height[k]));
    bimg.data[k * 4] = bimg.data[k * 4 + 1] = bimg.data[k * 4 + 2] = hv * 255;
    bimg.data[k * 4 + 3] = 255;
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

/** Steel bar grating (alpha-tested), one tile = `cells` × `cells` openings. */
export function makeGratingTexture(cells = 8, size = 256): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#c9a03a';
  const step = size / cells;
  // Bearing bars (thicker) one way, cross bars the other.
  for (let i = 0; i < cells; i++) ctx.fillRect(i * step, 0, step * 0.16, size);
  for (let i = 0; i < cells * 2; i++) ctx.fillRect(0, (i * step) / 2, size, step * 0.08);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * Texture atlas of small engraved tags (white plates, black text) laid out in
 * a grid; returns the texture and a function giving the UV rectangle of each.
 */
export function makeTagAtlas(labels: string[], opts: { cols?: number; cellW?: number; cellH?: number; bg?: string[] } = {}) {
  const cols = opts.cols ?? 4;
  const cw = opts.cellW ?? 128;
  const ch = opts.cellH ?? 64;
  const rows = Math.ceil(labels.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * cw;
  c.height = rows * ch;
  const ctx = c.getContext('2d')!;
  labels.forEach((text, i) => {
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * ch;
    ctx.fillStyle = opts.bg?.[i] ?? '#e9e7df';
    ctx.fillRect(x, y, cw, ch);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 3, y + 3, cw - 6, ch - 6);
    ctx.fillStyle = '#111';
    ctx.font = `bold ${Math.round(ch * 0.5)}px "IBM Plex Sans", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + cw / 2, y + ch * 0.54);
    // Fixing rivets.
    ctx.fillStyle = '#555';
    for (const rx of [x + 9, x + cw - 9]) {
      ctx.beginPath();
      ctx.arc(rx, y + ch / 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const uv = (i: number) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { u0: col / cols, u1: (col + 1) / cols, v0: 1 - (row + 1) / rows, v1: 1 - row / rows };
  };
  return { texture: tex, uv };
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
