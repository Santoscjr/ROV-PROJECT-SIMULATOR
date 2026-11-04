/**
 * Procedural, tileable textures and the shared surface shader patch used by
 * the WC-150 ROV model. Everything is generated once per model on the CPU
 * (DataTexture / CanvasTexture); sizes follow the quality level.
 *
 *  - detail   (RGBA data): R = chip / scratch mask, G = grime streaks,
 *                          B = brushed stripes, A = fine roughness noise.
 *                          Sampled in object space by `applySurfaceShader`.
 *  - foamNormal (RGB normal map): syntactic-foam pores + grain (also reused,
 *                          at a higher repeat, as micro-normal for rubber).
 *  - label    (canvas atlas): vehicle name, hazard stripes, small placards.
 *  - led      (canvas): LED array behind the lamp glass (map + emissiveMap).
 */
import * as THREE from 'three';
import type { Quality } from './rovModel';

export interface RovTextures {
  detail: THREE.DataTexture;
  foamNormal: THREE.DataTexture;
  rubberNormal: THREE.Texture;
  label: THREE.CanvasTexture;
  led: THREE.CanvasTexture;
  all: THREE.Texture[];
}

export function textureSize(q: Quality): number {
  return q === 'low' ? 256 : q === 'medium' ? 512 : 1024;
}

// ---------------------------------------------------------------------------
// Noise helpers (tileable value noise)
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Tileable value noise, `cu`×`cv` lattice cells over the n×n tile. Returns [0,1]. */
function valueNoise(n: number, cu: number, cv: number, seed: number, out?: Float32Array, amp = 1): Float32Array {
  const r = rng(seed);
  const lat = new Float32Array(cu * cv);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const o = out ?? new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const fy = (y / n) * cv;
    const y0 = Math.floor(fy);
    let ty = fy - y0;
    ty = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cv) * cu;
    const r1 = ((y0 + 1) % cv) * cu;
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cu;
      const x0 = Math.floor(fx);
      let tx = fx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const xa = x0 % cu;
      const xb = (x0 + 1) % cu;
      const a = lat[r0 + xa] + (lat[r0 + xb] - lat[r0 + xa]) * tx;
      const b = lat[r1 + xa] + (lat[r1 + xb] - lat[r1 + xa]) * tx;
      o[y * n + x] += (a + (b - a) * ty) * amp;
    }
  }
  return o;
}

function fbm(n: number, cells: number, octaves: number, seed: number, aspect = 1): Float32Array {
  const o = new Float32Array(n * n);
  let amp = 0.5;
  let c = cells;
  let total = 0;
  for (let k = 0; k < octaves && c <= n; k++) {
    valueNoise(n, Math.max(1, Math.round(c * aspect)), c, seed + k * 101, o, amp);
    total += amp;
    amp *= 0.5;
    c *= 2;
  }
  for (let i = 0; i < o.length; i++) o[i] /= total;
  return o;
}

function normalize01(a: Float32Array, contrast = 1): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const s = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < a.length; i++) {
    const v = (a[i] - lo) * s;
    a[i] = Math.min(1, Math.max(0, 0.5 + (v - 0.5) * contrast));
  }
}

function dataTexture(data: Uint8Array, n: number, repeat = 1): THREE.DataTexture {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function detailTexture(n: number): THREE.DataTexture {
  const r = rng(77);
  // R: chip mask = fractal noise with sparse scratches burnt in at high values
  const chips = fbm(n, 6, 6, 11);
  normalize01(chips, 1.5);
  for (let i = 0; i < chips.length; i++) chips[i] *= 0.9;
  const scratches = Math.round(n * 0.06);
  for (let k = 0; k < scratches; k++) {
    let x = r() * n;
    let y = r() * n;
    const ang = (r() - 0.5) * 0.9 + (r() < 0.5 ? 0 : Math.PI / 2);
    const len = n * (0.02 + r() * 0.08);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let s = 0; s < len; s++) {
      const xi = ((Math.round(x) % n) + n) % n;
      const yi = ((Math.round(y) % n) + n) % n;
      chips[yi * n + xi] = Math.max(chips[yi * n + xi], 0.9 + r() * 0.1);
      x += dx;
      y += dy;
    }
  }
  // G: grime streaks running along v (vertical on side faces)
  const grime = fbm(n, 4, 4, 23, 8);
  const blot = fbm(n, 3, 3, 29);
  for (let i = 0; i < grime.length; i++) grime[i] = grime[i] * 0.7 + blot[i] * 0.3;
  normalize01(grime, 1.6);
  // B: brushed stripes along u
  const brush = new Float32Array(n * n);
  valueNoise(n, 3, Math.min(n, 256), 31, brush, 0.6);
  valueNoise(n, 8, Math.min(n, 128), 37, brush, 0.4);
  normalize01(brush, 1.3);
  // A: fine roughness noise
  const fine = fbm(n, 16, 4, 41);
  normalize01(fine, 1.2);

  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = chips[i] * 255;
    data[i * 4 + 1] = grime[i] * 255;
    data[i * 4 + 2] = brush[i] * 255;
    data[i * 4 + 3] = fine[i] * 255;
  }
  const t = dataTexture(data, n);
  t.name = 'rov-detail';
  return t;
}

function foamNormalTexture(n: number): THREE.DataTexture {
  const r = rng(5);
  const h = fbm(n, 24, 4, 7);
  for (let i = 0; i < h.length; i++) h[i] *= 0.35;
  // Pores: small round dimples
  const pores = Math.round(n * n * 0.0025);
  const scale = n / 512;
  for (let k = 0; k < pores; k++) {
    const cx = r() * n;
    const cy = r() * n;
    const rad = (0.8 + r() * 2.2) * Math.max(0.6, scale);
    const depth = 0.4 + r() * 0.6;
    const ri = Math.ceil(rad);
    for (let y = -ri; y <= ri; y++) {
      for (let x = -ri; x <= ri; x++) {
        const d2 = (x * x + y * y) / (rad * rad);
        if (d2 > 1) continue;
        const xi = ((Math.floor(cx) + x) % n + n) % n;
        const yi = ((Math.floor(cy) + y) % n + n) % n;
        h[yi * n + xi] -= depth * (1 - d2);
      }
    }
  }
  const data = new Uint8Array(n * n * 4);
  const k = 2.2 * Math.max(0.5, scale);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const hl = h[y * n + ((x - 1 + n) % n)];
      const hr = h[y * n + ((x + 1) % n)];
      const hd = h[((y - 1 + n) % n) * n + x];
      const hu = h[((y + 1) % n) * n + x];
      let nx = (hl - hr) * k;
      let ny = (hd - hu) * k;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * n + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = dataTexture(data, n, 1.6);
  t.name = 'rov-foam-normal';
  return t;
}

// --- Decal atlas -------------------------------------------------------------

export type AtlasRect = [number, number, number, number]; // u0, u1, v0, v1

/** Small placard cells: 4 columns × 4 rows in the lower half of the atlas. */
export const PLACARDS = [
  'LIFT POINT', 'NO STEP', 'DANGER HV', 'HYD 210 BAR',
  'H1', 'H2', 'H3', 'H4',
  'V1', 'V2', 'V3', 'V4',
  'TETHER', 'WC-150', 'CAUTION', 'SONAR',
] as const;
export type Placard = (typeof PLACARDS)[number];

const PAD = 4 / 1024;
export const ATLAS_NAME: AtlasRect = [PAD, 1 - PAD, 1 - 340 / 1024, 1 - PAD];
export const ATLAS_STRIPES: AtlasRect = [PAD, 1 - PAD, 1 - 492 / 1024, 1 - 364 / 1024];

export function atlasPlacard(p: Placard): AtlasRect {
  const i = PLACARDS.indexOf(p);
  const c = i % 4;
  const row = Math.floor(i / 4);
  const y0 = 512 + row * 128;
  return [c / 4 + PAD, (c + 1) / 4 - PAD, 1 - (y0 + 128) / 1024 + PAD, 1 - y0 / 1024 - PAD];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function labelTexture(size: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.scale(size / 1024, size / 1024);
  ctx.clearRect(0, 0, 1024, 1024);
  const font = (px: number, w = 'bold') => `${w} ${px}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  // Name panel (y 0..340)
  ctx.fillStyle = '#121212';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(228);
  ctx.fillText('WC-150', 512, 236);
  ctx.fillRect(40, 262, 944, 10);
  ctx.font = font(44);
  ctx.fillText('WORK CLASS ROV  •  3000 MSW', 512, 322);
  // Hazard stripes (y 360..496)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 360, 1024, 136);
  ctx.clip();
  ctx.fillStyle = '#f2b705';
  ctx.fillRect(0, 360, 1024, 136);
  ctx.fillStyle = '#141414';
  for (let x = -200; x < 1200; x += 72) {
    ctx.beginPath();
    ctx.moveTo(x, 496);
    ctx.lineTo(x + 36, 496);
    ctx.lineTo(x + 36 + 136, 360);
    ctx.lineTo(x + 136, 360);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Placards (y 512..1024)
  ctx.textBaseline = 'middle';
  PLACARDS.forEach((text, i) => {
    const x = (i % 4) * 256;
    const y = 512 + Math.floor(i / 4) * 128;
    const cx = x + 128;
    const cy = y + 64;
    if (text === 'DANGER HV' || text === 'CAUTION') {
      ctx.fillStyle = '#f2b705';
      roundRect(ctx, x + 8, y + 12, 240, 104, 10);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#111';
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = font(text.length > 8 ? 40 : 46);
      ctx.fillText(text, cx, cy + 2);
    } else if (text.length <= 2) {
      // Thruster IDs: black stencil on transparent
      ctx.fillStyle = '#111';
      ctx.font = font(96);
      ctx.fillText(text, cx, cy + 4);
    } else {
      ctx.fillStyle = '#f4f4f0';
      roundRect(ctx, x + 8, y + 18, 240, 92, 8);
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#1a1a1a';
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = font(text.length > 9 ? 34 : 42);
      ctx.fillText(text, cx, cy + 2);
    }
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.name = 'rov-decals';
  return t;
}

function ledTexture(size: number): THREE.CanvasTexture {
  const n = Math.max(128, size >> 2);
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, n, n);
  // Reflector rings
  const c = n / 2;
  ctx.strokeStyle = '#3a3e44';
  ctx.lineWidth = n * 0.02;
  for (const rr of [0.47, 0.3]) {
    ctx.beginPath();
    ctx.arc(c, c, n * rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Hexagonal LED grid inside the lens
  const pitch = n * 0.14;
  for (let row = -4; row <= 4; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = c + (col + (row & 1 ? 0.5 : 0)) * pitch;
      const y = c + row * pitch * 0.866;
      if (Math.hypot(x - c, y - c) > n * 0.4) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, pitch * 0.45);
      g.addColorStop(0, '#fffbe8');
      g.addColorStop(0.45, '#ffe9a8');
      g.addColorStop(0.7, '#6b6250');
      g.addColorStop(1, 'rgba(40,40,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, pitch * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.name = 'rov-led';
  return t;
}

export function createRovTextures(q: Quality): RovTextures {
  const n = textureSize(q);
  const detail = detailTexture(n);
  const foamNormal = foamNormalTexture(n);
  // Same image source as foamNormal (single GPU upload), finer repeat.
  const rubberNormal = foamNormal.clone();
  rubberNormal.repeat.set(5, 5);
  rubberNormal.needsUpdate = true;
  const label = labelTexture(q === 'low' ? 512 : 1024);
  const led = ledTexture(n);
  return { detail, foamNormal, rubberNormal, label, led, all: [detail, foamNormal, rubberNormal, label, led] };
}

// ---------------------------------------------------------------------------
// Surface shader patch
// ---------------------------------------------------------------------------

export interface SurfaceOptions {
  /** Colour revealed where paint is chipped / scratched. */
  wearColor: number;
  /** Global multiplier on the per-vertex wear attribute (0 disables chips). */
  wearAmount: number;
  wearMetalness: number;
  wearRoughness: number;
  /** Strength of vertical grime streaks on side faces. */
  grime: number;
  /** Brushed-stripe roughness modulation (0..1). */
  brushed: number;
  /** Detail texture repeats per metre. */
  scale: number;
}

/**
 * Patches a standard/physical material to apply object-space detail:
 * chipped paint driven by the `wear` vertex attribute (x = wear, y = side
 * grime mask) and the detail texture, grime streaks and brushed roughness.
 * Cheap: one texture fetch with dominant-axis projection.
 */
export function applySurfaceShader(mat: THREE.MeshStandardMaterial, detail: THREE.Texture, o: SurfaceOptions): void {
  const uniforms = {
    uRovDetail: { value: detail },
    uRovScale: { value: o.scale },
    uRovWearColor: { value: new THREE.Color(o.wearColor) },
    uRovWear: { value: new THREE.Vector4(o.wearAmount, o.wearMetalness, o.wearRoughness, o.grime) },
    uRovBrush: { value: o.brushed },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 wear;\nvarying vec2 vRovWear;\nvarying vec3 vRovPos;\nvarying vec3 vRovN;',
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvRovN = objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRovPos = transformed;\nvRovWear = wear;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uRovDetail;
uniform float uRovScale;
uniform vec3 uRovWearColor;
uniform vec4 uRovWear;
uniform float uRovBrush;
varying vec2 vRovWear;
varying vec3 vRovPos;
varying vec3 vRovN;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 rovAn = abs(vRovN);
vec3 rovP = vRovPos * uRovScale;
vec2 rovUv = (rovAn.x > rovAn.y && rovAn.x > rovAn.z) ? rovP.zy : ((rovAn.y > rovAn.z) ? rovP.xz : rovP.xy);
vec4 rovD = texture2D(uRovDetail, rovUv);
float rovChip = smoothstep(0.0, 0.035, rovD.r - (1.0 - clamp(vRovWear.x * uRovWear.x, 0.0, 1.0)));
diffuseColor.rgb = mix(diffuseColor.rgb, uRovWearColor, rovChip);
float rovG = texture2D(uRovDetail, rovUv * 0.21 + vec2(0.37, 0.11)).g;
diffuseColor.rgb *= mix(1.0, 0.5 + 0.5 * rovG, uRovWear.w * vRovWear.y * (1.0 - rovChip));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor *= mix(1.0, 0.65 + 0.7 * rovD.b, uRovBrush) * (0.9 + 0.2 * rovD.a);
roughnessFactor = clamp(mix(roughnessFactor, uRovWear.z, rovChip), 0.04, 1.0);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, uRovWear.y, rovChip);',
      );
  };
  mat.customProgramCacheKey = () => 'rov-surface-v2';
}
