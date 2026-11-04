import {
  BufferAttribute,
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { SITE_CENTER, fbm, terrainHeight, terrainNormal } from '../sim/terrain';
import { makeSandTextures } from './materials';
import type { GraphicsQuality } from '../config/settings';

export const SEABED_BOUNDS = { minX: -140, maxX: 230, minZ: -230, maxZ: 110 };

const RES: Record<GraphicsQuality, number> = { low: 140, medium: 220, high: 300 };
const ROCKS: Record<GraphicsQuality, number> = { low: 250, medium: 600, high: 1100 };
const LIFE: Record<GraphicsQuality, number> = { low: 150, medium: 450, high: 900 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createSeabed(quality: GraphicsQuality): Group {
  const group = new Group();
  group.name = 'seabed';
  const b = SEABED_BOUNDS;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const res = RES[quality];
  const geo = new PlaneGeometry(w, d, res, Math.round((res * d) / w));
  geo.rotateX(-Math.PI / 2);
  geo.translate(b.minX + w / 2, 0, b.minZ + d / 2);
  const pos = geo.attributes.position as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    // Subtle colour variation: darker silt patches, lighter shell sand.
    const n = fbm(x / 14, z / 14, 3);
    const m = fbm(x / 3.5 + 40, z / 3.5, 2);
    c.setRGB(0.78 + n * 0.12 + m * 0.05, 0.76 + n * 0.1 + m * 0.04, 0.68 + n * 0.08);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const { map, bump } = makeSandTextures(quality === 'low' ? 256 : 512);
  const rep = w / 5;
  map.repeat.set(rep, (rep * d) / w);
  bump.repeat.copy(map.repeat);
  const mat = new MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 1.2,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  });
  const ground = new Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.name = 'terrain';
  group.add(ground);

  // --- Rocks / boulders (avoid the prepared site and the pipeline corridor) --------------
  const r = rng(1337);
  const rockGeo = new IcosahedronGeometry(1, quality === 'low' ? 0 : 1);
  const rp = rockGeo.attributes.position as BufferAttribute;
  for (let i = 0; i < rp.count; i++) {
    const v = new Vector3(rp.getX(i), rp.getY(i), rp.getZ(i));
    const k = 0.75 + fbm(v.x * 1.7 + 3, v.z * 1.7 + v.y, 2) * 0.5;
    v.multiplyScalar(k);
    rp.setXYZ(i, v.x, v.y * 0.7, v.z);
  }
  rockGeo.computeVertexNormals();
  const rockMat = new MeshStandardMaterial({ color: 0x6d6a60, roughness: 0.95, flatShading: quality !== 'high' });
  const nRocks = ROCKS[quality];
  const rocks = new InstancedMesh(rockGeo, rockMat, nRocks);
  rocks.instanceMatrix.setUsage(DynamicDrawUsage);
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const col = new Color();
  let placed = 0;
  for (let i = 0; i < nRocks * 3 && placed < nRocks; i++) {
    const x = b.minX + r() * w;
    const z = b.minZ + r() * d;
    const distSite = Math.hypot(x - SITE_CENTER.x, z - SITE_CENTER.z);
    if (distSite < 30) continue;
    // Cluster rocks using noise.
    if (fbm(x / 25, z / 25, 2) < 0.05 && r() > 0.25) continue;
    const size = 0.15 + Math.pow(r(), 3) * 1.6;
    p.set(x, terrainHeight(x, z) + size * 0.15, z);
    q.setFromAxisAngle(new Vector3(r(), r(), r()).normalize(), r() * Math.PI * 2);
    s.set(size * (0.8 + r() * 0.6), size * (0.6 + r() * 0.5), size * (0.8 + r() * 0.6));
    m.compose(p, q, s);
    rocks.setMatrixAt(placed, m);
    const g = 0.75 + r() * 0.35;
    rocks.setColorAt(placed, col.setRGB(g, g * 0.97, g * 0.9));
    placed++;
  }
  rocks.count = placed;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  group.add(rocks);

  // --- Sessile life: sponges / soft corals (small cones), denser near hard substrate.
  const lifeGeo = new ConeGeometry(0.12, 0.5, 6, 1, false);
  lifeGeo.translate(0, 0.25, 0);
  const lifeMat = new MeshStandardMaterial({ roughness: 0.8, color: 0xffffff });
  const nLife = LIFE[quality];
  const life = new InstancedMesh(lifeGeo, lifeMat, nLife);
  const palette = [new Color(0.85, 0.55, 0.35), new Color(0.9, 0.82, 0.62), new Color(0.75, 0.32, 0.3), new Color(0.88, 0.88, 0.8)];
  const up = new Vector3(0, 1, 0);
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
  life.castShadow = quality === 'high';
  life.receiveShadow = true;
  group.add(life);

  return group;
}
