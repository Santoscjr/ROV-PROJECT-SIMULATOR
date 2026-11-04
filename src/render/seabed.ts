import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RGBADepthPacking,
  SphereGeometry,
  TorusGeometry,
  BoxGeometry,
  Vector2,
  Vector3,
  Vector4,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SITE_CENTER, fbm, terrainHeight, terrainNormal } from '../sim/terrain';
import { MANIFOLD, PIPELINE_PATH, PIPELINE_RADIUS, PLET, TREE } from '../sim/site';
import { NOISE_GLSL, PERTURB_GLSL, fouledMaterial, makeSandTextures } from './materials';
import type { GraphicsQuality } from '../config/settings';

export const SEABED_BOUNDS = { minX: -140, maxX: 230, minZ: -230, maxZ: 110 };

const RES: Record<GraphicsQuality, number> = { low: 140, medium: 220, high: 300 };
const ROCKS: Record<GraphicsQuality, number> = { low: 260, medium: 650, high: 1100 };
const COBBLES: Record<GraphicsQuality, number> = { low: 120, medium: 380, high: 800 };
const LIFE: Record<GraphicsQuality, number> = { low: 150, medium: 450, high: 900 };
const SHELLS: Record<GraphicsQuality, number> = { low: 150, medium: 500, high: 1000 };
/** Terrain and rocks are split into CHUNKS × CHUNKS tiles for frustum/visibility culling. */
const CHUNKS = 4;

/** An object hidden when the camera is further than the water lets one see. */
export interface Cullable {
  object: Object3D;
  box: Box3;
}

export interface SeabedBuild {
  group: Group;
  cullables: Cullable[];
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Structure footprints (mudmats) for scour / sediment shading: centre xz, half size, yaw. */
function footprints(): { f: Vector4[]; r: Vector2[] } {
  const f: Vector4[] = [];
  const r: Vector2[] = [];
  const add = (x: number, z: number, hx: number, hz: number, yaw: number) => {
    f.push(new Vector4(x, z, hx, hz));
    r.push(new Vector2(Math.cos(yaw), Math.sin(yaw)));
  };
  add(MANIFOLD.position.x, MANIFOLD.position.z, MANIFOLD.size.x / 2 + 0.3, MANIFOLD.size.z / 2 + 0.3, MANIFOLD.yaw);
  add(TREE.position.x, TREE.position.z, TREE.size.x / 2 + 0.3, TREE.size.z / 2 + 0.3, TREE.yaw);
  add(PLET.position.x, PLET.position.z, PLET.size.x / 2 + 0.2, PLET.size.z / 2 + 0.2, 0);
  return { f, r };
}

/** Seabed scars (anchor drag / old plough trench) as segments in the xz plane. */
const SCARS = [
  [-34, -12, -22, -175],
  [52, 10, 150, -150],
];

/**
 * Terrain material: world-space sand texture at two scales (no visible
 * tiling), procedural ripples, grains, scour/sediment around the structures,
 * drill cuttings around the well and seabed scars. Relief is applied to the
 * normal only (the shared height field used by physics is unchanged), faded
 * with distance so it never aliases.
 */
function terrainMaterial(quality: GraphicsQuality): MeshStandardMaterial {
  const { map, bump } = makeSandTextures(quality === 'low' ? 256 : 512);
  const mat = new MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 0.6,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  });
  const fp = footprints();
  const detail = quality === 'low' ? 0 : 1;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFoot = { value: fp.f };
    shader.uniforms.uFootRot = { value: fp.r };
    shader.uniforms.uWell = { value: new Vector2(TREE.position.x, TREE.position.z) };
    shader.uniforms.uSite = { value: new Vector2(SITE_CENTER.x, SITE_CENTER.z) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const scars = SCARS.map((s) => `vec4(${s.map((v) => v.toFixed(1)).join(', ')})`).join(', ');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        #define SEABED_DETAIL ${detail}
        varying vec3 vWPos;
        uniform vec4 uFoot[3];
        uniform vec2 uFootRot[3];
        uniform vec2 uWell;
        uniform vec2 uSite;
        ${NOISE_GLSL}
        ${PERTURB_GLSL}
        float boxSd(vec2 p, vec4 f, vec2 cs) {
          vec2 d = p - f.xy;
          d = vec2(d.x * cs.x - d.y * cs.y, d.x * cs.y + d.y * cs.x);
          vec2 q = abs(d) - f.zw;
          return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        }
        float segD(vec2 p, vec2 a, vec2 b) {
          vec2 pa = p - a, ba = b - a;
          float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
          return length(pa - ba * h);
        }
        // Seabed features shared by colour and relief.
        float sbScour = 0.0;   // 0..1 fine silt band around structures
        float sbCuttings = 0.0;
        float sbScar = 0.0;
        float sbHeight = 0.0;
        void seabedFeatures(vec2 p) {
          float sd = 1e3;
          for (int i = 0; i < 3; i++) sd = min(sd, boxSd(p, uFoot[i], uFootRot[i]));
          float n = wNoise(vec3(p * 0.9, 2.0));
          sbScour = (1.0 - smoothstep(0.0, 2.2 + n * 1.2, sd)) * step(-0.2, sd);
          // Scour moat at the mudmat edge and a low berm of deposited fines.
          sbHeight += -0.10 * exp(-max(sd, 0.0) / 0.45) * step(-0.05, sd) + 0.035 * exp(-pow((sd - 1.3) / 0.5, 2.0));
          // Drill cuttings around the well: pale grey, lumpy.
          float dw = length(p - uWell);
          sbCuttings = (1.0 - smoothstep(3.0, 8.5 + n * 2.5, dw)) * step(1.5, sd);
          sbHeight += sbCuttings * (wNoise(vec3(p * 1.6, 9.0)) - 0.5) * 0.08;
          // Scars: groove with low berms either side.
          ${'const vec4 SCARS[2] = vec4[2](' + scars + ');'}
          for (int i = 0; i < 2; i++) {
            float d = segD(p, SCARS[i].xy, SCARS[i].zw) + (wNoise(vec3(p * 0.3, float(i))) - 0.5) * 0.6;
            float g = exp(-pow(d / 0.35, 2.0));
            sbScar = max(sbScar, g);
            sbHeight += -0.08 * g + 0.035 * exp(-pow((d - 0.65) / 0.25, 2.0));
          }
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `
        seabedFeatures(vWPos.xz);
        #ifdef USE_MAP
          vec4 s1 = texture2D(map, vWPos.xz / 5.0);
          vec4 s2 = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * vWPos.xz / 13.0 + 0.37);
          float mixN = wNoise(vec3(vWPos.xz * 0.08, 1.7));
          diffuseColor *= mix(s1, s2, smoothstep(0.3, 0.7, mixN));
        #endif
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.77, 0.74), sbScour * 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.62, 0.60) * (0.85 + 0.3 * wNoise(vec3(vWPos.xz * 3.0, 4.0))), sbCuttings * 0.75);
        diffuseColor.rgb *= 1.0 - sbScar * 0.18;
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          float camD = length(vWPos - cameraPosition);
          float fade = 1.0 - smoothstep(5.0, 32.0, camD);
          float H = sbHeight;
          #if SEABED_DETAIL > 0
          if (fade > 0.0) {
            // Current ripples: crest direction wanders slowly, asymmetric profile.
            vec2 dir = normalize(vec2(0.93, 0.36) + (wNoise(vec3(p * 0.04, 7.0)) - 0.5) * 0.9);
            float ph = dot(p, dir) * 6.2831 / 0.42 + wNoise(vec3(p * 0.3, 3.1)) * 7.0;
            float aa = clamp(1.4 - fwidth(ph) * 0.6, 0.0, 1.0);
            float rip = (sin(ph) + 0.3 * sin(2.0 * ph + 1.2)) * aa;
            float field = smoothstep(0.3, 0.6, wNoise(vec3(p * 0.05, 11.0)));
            field *= (1.0 - sbScour) * (1.0 - sbCuttings) * (1.0 - sbScar);
            H += rip * 0.014 * field * fade;
            // Lumps, bioturbation mounds and burrow holes.
            H += (wNoise(vec3(p * 2.3, 5.0)) - 0.5) * 0.03 * fade;
            float cell = wHash(vec3(floor(p * 1.3), 1.0));
            vec2 f = fract(p * 1.3) - 0.5;
            H += step(0.93, cell) * (-0.025 * exp(-dot(f, f) * 160.0) + 0.012 * exp(-dot(f, f) * 30.0)) * fade;
            float gaa = clamp(1.5 - fwidth(p.x * 11.0), 0.0, 1.0);
            H += (wNoise(vec3(p * 11.0, 0.0)) - 0.5) * 0.004 * gaa * fade;
          }
          #endif
          normal = surfPerturb(-vViewPosition, normal, vec2(dFdx(H), dFdy(H)), faceDirection);
        }`,
      );
  };
  mat.customProgramCacheKey = () => `seabed-${detail}`;
  return mat;
}

/** Height-mapped terrain tile with analytic normals (seamless across tiles). */
function terrainTile(x0: number, z0: number, w: number, d: number, sx: number, sz: number): BufferGeometry {
  const geo = new PlaneGeometry(w, d, sx, sz);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x0 + w / 2, 0, z0 + d / 2);
  const pos = geo.attributes.position as BufferAttribute;
  const nrm = geo.attributes.normal as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const e = Math.max(0.3, (w / sx) * 0.5);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    const n = terrainNormal(x, z, e);
    nrm.setXYZ(i, n[0], n[1], n[2]);
    // Subtle colour variation: darker silt patches, lighter shell sand.
    const a = fbm(x / 14, z / 14, 3);
    const m = fbm(x / 3.5 + 40, z / 3.5, 2);
    colors[i * 3] = 0.78 + a * 0.12 + m * 0.05;
    colors[i * 3 + 1] = 0.76 + a * 0.1 + m * 0.04;
    colors[i * 3 + 2] = 0.68 + a * 0.08;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Boulder material: one base geometry, every instance reshaped in the vertex
 * shader by noise keyed to its position (no two rocks alike), flat shaded,
 * with growth and silt on top. A matching depth material keeps the shadows.
 */
function rockMaterials(): { mat: MeshStandardMaterial; depth: MeshDepthMaterial } {
  const displace = /* glsl */ `
    {
      vec3 iSeed = vec3(0.0);
      #ifdef USE_INSTANCING
        iSeed = instanceMatrix[3].xyz;
      #endif
      float n1 = wNoise(position * 1.3 + iSeed * 0.37);
      float n2 = wNoise(position * 3.7 + iSeed * 0.11);
      float slab = step(0.6, fract(iSeed.x * 0.173 + iSeed.z * 0.311));
      transformed *= 0.72 + 0.5 * n1 + 0.14 * n2;
      // Some are angular slabs, all have a flattened base.
      transformed.y *= mix(1.0, 0.55, slab);
      transformed.y = max(transformed.y, -0.3);
    }`;
  const mat = fouledMaterial(
    { color: 0x7a766b, roughness: 0.95, flatShading: true },
    { amount: 0.35, sediment: 0.85, scale: 2.2, chips: 0, relief: 0.8, growth: new Color(0.3, 0.3, 0.22) },
  );
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${displace}`);
  };
  mat.customProgramCacheKey = () => 'rock-v2';
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${displace}`);
  };
  depth.customProgramCacheKey = () => 'rock-depth-v2';
  return { mat, depth };
}

interface RockInstance {
  m: Matrix4;
  c: Color;
}

export function createSeabed(quality: GraphicsQuality): SeabedBuild {
  const group = new Group();
  group.name = 'seabed';
  const cullables: Cullable[] = [];
  const b = SEABED_BOUNDS;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const res = RES[quality];
  const resZ = Math.round((res * d) / w);
  const tileW = w / CHUNKS;
  const tileD = d / CHUNKS;
  const sx = Math.round(res / CHUNKS);
  const sz = Math.round(resZ / CHUNKS);
  const terrainMat = terrainMaterial(quality);
  const tiles: Mesh[] = [];
  for (let j = 0; j < CHUNKS; j++) {
    for (let i = 0; i < CHUNKS; i++) {
      const geo = terrainTile(b.minX + i * tileW, b.minZ + j * tileD, tileW, tileD, sx, sz);
      const tile = new Mesh(geo, terrainMat);
      tile.receiveShadow = true;
      tile.name = 'terrain';
      tiles.push(tile);
      group.add(tile);
      cullables.push({ object: tile, box: geo.boundingBox!.clone() });
    }
  }
  const chunkOf = (x: number, z: number) => {
    const i = Math.min(CHUNKS - 1, Math.max(0, Math.floor((x - b.minX) / tileW)));
    const j = Math.min(CHUNKS - 1, Math.max(0, Math.floor((z - b.minZ) / tileD)));
    return j * CHUNKS + i;
  };

  // --- Rocks: boulders, cobble patches, a rock berm over the pipeline -------------------
  const r = rng(1337);
  const rockGeo = new IcosahedronGeometry(1, quality === 'high' ? 2 : 1);
  rockGeo.scale(1, 0.7, 1);
  const { mat: rockMat, depth: rockDepth } = rockMaterials();
  const chunks: RockInstance[][] = Array.from({ length: CHUNKS * CHUNKS }, () => []);
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const addRock = (x: number, z: number, size: number, bury: number, tint: number) => {
    p.set(x, terrainHeight(x, z) + size * (0.12 - bury), z);
    q.setFromAxisAngle(new Vector3(r() - 0.5, 1.5, r() - 0.5).normalize(), r() * Math.PI * 2);
    s.set(size * (0.8 + r() * 0.6), size * (0.6 + r() * 0.5), size * (0.8 + r() * 0.6));
    const g = tint * (0.8 + r() * 0.3);
    const warm = 0.94 + r() * 0.08;
    chunks[chunkOf(x, z)].push({ m: new Matrix4().compose(p.clone(), q.clone(), s.clone()), c: new Color(g * warm, g * 0.97, g * 0.9 / warm) });
  };
  const nRocks = ROCKS[quality];
  let placed = 0;
  const boulders: [number, number][] = [];
  for (let i = 0; i < nRocks * 3 && placed < nRocks; i++) {
    const x = b.minX + r() * w;
    const z = b.minZ + r() * d;
    if (Math.hypot(x - SITE_CENTER.x, z - SITE_CENTER.z) < 30) continue;
    // Cluster rocks using noise.
    if (fbm(x / 25, z / 25, 2) < 0.05 && r() > 0.25) continue;
    const size = 0.15 + Math.pow(r(), 3) * 1.7;
    addRock(x, z, size, r() * 0.3, 1);
    if (size > 0.5) boulders.push([x, z]);
    placed++;
  }
  // Cobble/gravel patches around some boulders.
  const nCob = COBBLES[quality];
  for (let i = 0; i < nCob && boulders.length; i++) {
    const [bx, bz] = boulders[Math.floor(r() * boulders.length)];
    const a = r() * Math.PI * 2;
    const rr = 0.6 + r() * 3;
    addRock(bx + Math.cos(a) * rr, bz + Math.sin(a) * rr, 0.05 + r() * 0.16, 0.2, 0.95);
  }
  // Rock berm (stabilisation dump) over a stretch of the pipeline, away from the free span.
  const bermN = quality === 'low' ? 120 : quality === 'medium' ? 220 : 320;
  const bermA = Math.floor(PIPELINE_PATH.length * 0.68);
  const bermB = Math.floor(PIPELINE_PATH.length * 0.76);
  for (let i = 0; i < bermN; i++) {
    const t = bermA + r() * (bermB - bermA);
    const k = Math.floor(t);
    const f = t - k;
    const pa = PIPELINE_PATH[k];
    const pb = PIPELINE_PATH[Math.min(k + 1, PIPELINE_PATH.length - 1)];
    const cx = pa.x + (pb.x - pa.x) * f;
    const cz = pa.z + (pb.z - pa.z) * f;
    const dx = pb.x - pa.x;
    const dz = pb.z - pa.z;
    const l = Math.hypot(dx, dz) || 1;
    const off = (r() - 0.5) * 2;
    const lat = off * 1.8;
    const x = cx - (dz / l) * lat;
    const z = cz + (dx / l) * lat;
    const size = 0.14 + r() * 0.22;
    // Trapezoidal profile: highest over the pipe.
    const top = (1 - Math.abs(off) * 0.8) * (PIPELINE_RADIUS * 2 + 0.25);
    p.set(x, terrainHeight(x, z) + top * r(), z);
    q.setFromAxisAngle(new Vector3(r() - 0.5, 1, r() - 0.5).normalize(), r() * Math.PI * 2);
    s.set(size, size * 0.75, size * (0.8 + r() * 0.4));
    const g = 0.72 + r() * 0.2;
    chunks[chunkOf(x, z)].push({ m: new Matrix4().compose(p.clone(), q.clone(), s.clone()), c: new Color(g * 0.95, g * 0.95, g) });
  }
  chunks.forEach((list) => {
    if (!list.length) return;
    const rocks = new InstancedMesh(rockGeo, rockMat, list.length);
    list.forEach((it, k) => {
      rocks.setMatrixAt(k, it.m);
      rocks.setColorAt(k, it.c);
    });
    rocks.computeBoundingBox();
    rocks.computeBoundingSphere();
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    rocks.customDepthMaterial = rockDepth;
    rocks.name = 'rocks';
    group.add(rocks);
    cullables.push({ object: rocks, box: rocks.boundingBox!.clone().expandByScalar(0.5) });
  });

  // --- Sessile life: sponges / soft corals (small cones), denser near hard substrate.
  const lifeGeo = new ConeGeometry(0.12, 0.5, 6, 1, false);
  lifeGeo.translate(0, 0.25, 0);
  const lifeMat = new MeshStandardMaterial({ roughness: 0.8, color: 0xffffff });
  const nLife = LIFE[quality];
  const life = new InstancedMesh(lifeGeo, lifeMat, nLife);
  const palette = [new Color(0.85, 0.55, 0.35), new Color(0.9, 0.82, 0.62), new Color(0.75, 0.32, 0.3), new Color(0.88, 0.88, 0.8)];
  const up = new Vector3(0, 1, 0);
  const m = new Matrix4();
  for (let i = 0; i < nLife; i++) {
    const x = b.minX + r() * w;
    const z = b.minZ + r() * d;
    const n = terrainNormal(x, z);
    q.setFromUnitVectors(up, new Vector3(n[0] + (r() - 0.5) * 0.4, n[1], n[2] + (r() - 0.5) * 0.4).normalize());
    const sc = 0.4 + r() * 1.2;
    s.set(sc * (0.7 + r() * 0.6), sc, sc * (0.7 + r() * 0.6));
    p.set(x, terrainHeight(x, z) - 0.03, z);
    m.compose(p, q, s);
    life.setMatrixAt(i, m);
    life.setColorAt(i, palette[Math.floor(r() * palette.length)]);
  }
  life.instanceMatrix.setUsage(DynamicDrawUsage);
  life.castShadow = quality === 'high';
  life.receiveShadow = true;
  group.add(life);

  // --- Shells and shell hash around the site (scale cue at 1–3 m).
  const nShell = SHELLS[quality];
  const shellGeo = new SphereGeometry(1, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  const shells = new InstancedMesh(shellGeo, new MeshStandardMaterial({ roughness: 0.55, color: 0xffffff }), nShell);
  const shellCols = [new Color(0.92, 0.88, 0.8), new Color(0.85, 0.72, 0.62), new Color(0.75, 0.7, 0.66), new Color(0.95, 0.93, 0.9)];
  for (let i = 0; i < nShell; i++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * 48;
    const x = SITE_CENTER.x + Math.cos(a) * rad;
    const z = SITE_CENTER.z + Math.sin(a) * rad;
    const sc = 0.025 + r() * 0.045;
    const n = terrainNormal(x, z);
    q.setFromUnitVectors(up, new Vector3(n[0] + (r() - 0.5) * 0.6, 1, n[2] + (r() - 0.5) * 0.6).normalize());
    if (r() < 0.4) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI)); // upside down
    p.set(x, terrainHeight(x, z) + 0.004, z);
    s.set(sc, sc * 0.35, sc * 0.9);
    m.compose(p, q, s);
    shells.setMatrixAt(i, m);
    shells.setColorAt(i, shellCols[Math.floor(r() * shellCols.length)]);
  }
  shells.computeBoundingBox();
  shells.computeBoundingSphere();
  shells.receiveShadow = true;
  shells.name = 'shells';
  group.add(shells);
  cullables.push({ object: shells, box: shells.boundingBox!.clone() });

  // --- Dropped objects / debris: scale cues near the site.
  const debris = createDebris(quality);
  group.add(debris);
  debris.geometry.computeBoundingBox();
  cullables.push({ object: debris, box: debris.geometry.boundingBox!.clone() });

  void tiles;
  return { group, cullables };
}

/** Old anchor chain, a drum, a scaffold tube, a fender tyre and a beam offcut. */
function createDebris(quality: GraphicsQuality): Mesh {
  const parts: BufferGeometry[] = [];
  const put = (geo: BufferGeometry, color: Color, m: Matrix4) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new BufferAttribute(c, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    parts.push(g);
  };
  const ground = (x: number, z: number) => terrainHeight(x, z);
  const rust = new Color(0.36, 0.22, 0.13);
  // Anchor chain (~11 m of 76 mm studless chain) lying in a lazy S.
  const seg = quality === 'low' ? 6 : 9;
  const link = new TorusGeometry(0.1, 0.034, 5, seg);
  link.scale(1.55, 1, 1);
  const start = new Vector3(11, 0, -66);
  const pitch = 0.27;
  const nLinks = 42;
  let heading = 0.35;
  const pos = start.clone();
  for (let i = 0; i < nLinks; i++) {
    heading += Math.sin(i * 0.18) * 0.06;
    const dir = new Vector3(Math.cos(heading), 0, Math.sin(heading));
    pos.addScaledVector(dir, pitch);
    const flat = i % 2 === 0;
    const y = ground(pos.x, pos.z) + (flat ? 0.02 : 0.085) - (i > 30 ? (i - 30) * 0.01 : 0);
    const qd = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), dir);
    const qr = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), flat ? Math.PI / 2 : 0);
    put(link.clone(), rust, new Matrix4().compose(new Vector3(pos.x, y, pos.z), qd.multiply(qr), new Vector3(1, 1, 1)));
  }
  // Crushed 200 l drum on its side, half buried.
  const drum = new CylinderGeometry(0.29, 0.29, 0.88, 14, 1);
  const dp = drum.attributes.position as BufferAttribute;
  for (let i = 0; i < dp.count; i++) {
    const x = dp.getX(i);
    const z = dp.getZ(i);
    if (x > 0.1) dp.setX(i, x * 0.7);
    dp.setZ(i, z * (1 + 0.08 * Math.sin(dp.getY(i) * 9)));
  }
  drum.computeVertexNormals();
  put(drum, new Color(0.2, 0.3, 0.42), new Matrix4().compose(new Vector3(40, ground(40, -94) + 0.17, -94), new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0.6, 0.2)), new Vector3(1, 1, 1)));
  // Scaffold tube with a coupler.
  const tubeQ = new Quaternion().setFromEuler(new Euler(0, 0.9, Math.PI / 2));
  put(new CylinderGeometry(0.024, 0.024, 4, 8), new Color(0.55, 0.56, 0.55), new Matrix4().compose(new Vector3(-3, ground(-3, -84) + 0.03, -84), tubeQ, new Vector3(1, 1, 1)));
  put(new BoxGeometry(0.09, 0.09, 0.12), new Color(0.5, 0.5, 0.48), new Matrix4().compose(new Vector3(-3.6, ground(-3.6, -84.8) + 0.05, -84.8), tubeQ, new Vector3(1, 1, 1)));
  // Fender tyre lying flat.
  put(new TorusGeometry(0.42, 0.15, 8, 18), new Color(0.07, 0.07, 0.07), new Matrix4().compose(new Vector3(18, ground(18, -103) + 0.1, -103), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 + 0.08), new Vector3(1, 1, 1)));
  // I-beam offcut resting at an angle.
  const ib = new Matrix4().compose(new Vector3(46, ground(46, -69) + 0.12, -69), new Quaternion().setFromEuler(new Euler(0.12, 0.4, 0.05)), new Vector3(1, 1, 1));
  put(new BoxGeometry(2.2, 0.02, 0.2), rust, new Matrix4().makeTranslation(0, 0.1, 0).premultiply(ib));
  put(new BoxGeometry(2.2, 0.02, 0.2), rust, new Matrix4().makeTranslation(0, -0.1, 0).premultiply(ib));
  put(new BoxGeometry(2.2, 0.2, 0.015), rust, ib.clone());
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  const mat: Material = fouledMaterial(
    { vertexColors: true, roughness: 0.75, metalness: 0.3 },
    { amount: 0.5, sediment: 0.8, chips: 0.4, scale: 3, relief: 1 },
  );
  const mesh = new Mesh(merged, mat);
  mesh.name = 'debris';
  mesh.castShadow = quality !== 'low';
  mesh.receiveShadow = true;
  return mesh;
}
