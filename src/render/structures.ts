import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  FREE_SPAN,
  INSPECTION_POINTS,
  JUMPER_PATH,
  JUMPER_RADIUS,
  MANIFOLD,
  PIPELINE_PATH,
  PIPELINE_RADIUS,
  PLET,
  TREE,
  type V3,
} from '../sim/site';
import { terrainHeight } from '../sim/terrain';
import { fouledMaterial, makeLabelTexture } from './materials';
import type { GraphicsQuality } from '../config/settings';

type MatKey = 'paint' | 'steel' | 'pipe' | 'handle' | 'anode' | 'dark' | 'concrete';

/** Collects geometry per material and merges it into few draw calls. */
class Builder {
  private parts = new Map<MatKey, BufferGeometry[]>();
  add(key: MatKey, geo: BufferGeometry, m?: Matrix4): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (m) g.applyMatrix4(m);
    // Keep only the attributes every part shares.
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const list = this.parts.get(key) ?? [];
    list.push(g);
    this.parts.set(key, list);
  }
  box(key: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, rot?: Euler): void {
    this.add(key, new BoxGeometry(sx, sy, sz), compose(x, y, z, rot));
  }
  cyl(key: MatKey, r: number, h: number, x: number, y: number, z: number, rot?: Euler, seg = 16): void {
    this.add(key, new CylinderGeometry(r, r, h, seg), compose(x, y, z, rot));
  }
  /** Beam between two points with a square section. */
  beam(key: MatKey, a: Vector3, b: Vector3, size: number): void {
    const dir = new Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new BoxGeometry(size, len, size);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    const m = new Matrix4().compose(new Vector3().addVectors(a, b).multiplyScalar(0.5), q, new Vector3(1, 1, 1));
    this.add(key, geo, m);
  }
  build(materials: Record<MatKey, Material>, root: Group, transform?: Matrix4): void {
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      if (transform) merged.applyMatrix4(transform);
      const mesh = new Mesh(merged, materials[key]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      list.forEach((g) => g.dispose());
    }
  }
}

function compose(x: number, y: number, z: number, rot?: Euler): Matrix4 {
  const m = new Matrix4();
  m.compose(new Vector3(x, y, z), new Quaternion().setFromEuler(rot ?? new Euler()), new Vector3(1, 1, 1));
  return m;
}

const RX = (a: number) => new Euler(a, 0, 0);
const RZ = (a: number) => new Euler(0, 0, a);
const HALF = Math.PI / 2;

function makeMaterials(): Record<MatKey, Material> {
  return {
    paint: fouledMaterial({ color: 0xd9a21b, roughness: 0.6, metalness: 0.1 }, { amount: 0.55, sediment: 0.7 }),
    steel: fouledMaterial({ color: 0x8a8f94, roughness: 0.45, metalness: 0.7 }, { amount: 0.4, sediment: 0.5 }),
    pipe: fouledMaterial({ color: 0x2a2c2e, roughness: 0.7, metalness: 0.1 }, { amount: 0.45, sediment: 0.8, scale: 1.1 }),
    handle: fouledMaterial({ color: 0xe86a1c, roughness: 0.5, metalness: 0.1 }, { amount: 0.2, sediment: 0.3 }),
    anode: new MeshStandardMaterial({ color: 0xb7b9b6, roughness: 0.85, metalness: 0.3 }),
    dark: fouledMaterial({ color: 0x3b3f44, roughness: 0.6, metalness: 0.4 }, { amount: 0.35, sediment: 0.5 }),
    concrete: fouledMaterial({ color: 0x8c8a83, roughness: 0.95, metalness: 0 }, { amount: 0.4, sediment: 0.9 }),
  };
}

/** Gate valve with actuator, handwheel and ROV handle, axis along local X. */
function valve(b: Builder, x: number, y: number, z: number, scale = 1): void {
  b.box('steel', 0.55 * scale, 0.6 * scale, 0.55 * scale, x, y, z);
  b.cyl('dark', 0.22 * scale, 0.7 * scale, x, y + 0.6 * scale, z);
  b.add('handle', new TorusGeometry(0.22 * scale, 0.035 * scale, 6, 18), compose(x, y + 1.0 * scale, z, RX(HALF)));
  b.cyl('handle', 0.05 * scale, 0.25 * scale, x, y + 1.08 * scale, z);
}

function hub(b: Builder, x: number, y: number, z: number, axis: 'x' | 'y', r: number): void {
  const rot = axis === 'x' ? RZ(HALF) : undefined;
  b.cyl('steel', r * 1.9, 0.18, x, y, z, rot, 24);
  b.cyl('steel', r * 1.5, 0.5, axis === 'x' ? x - 0.3 : x, axis === 'y' ? y - 0.3 : y, z, rot, 24);
  // clamp halves
  b.box('dark', axis === 'x' ? 0.35 : r * 4.4, axis === 'x' ? r * 4.4 : 0.35, r * 1.2, x + (axis === 'x' ? 0.1 : 0), y, z);
  // bolts around the flange
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const oy = Math.cos(a) * r * 1.7;
    const oz = Math.sin(a) * r * 1.7;
    if (axis === 'x') b.cyl('steel', 0.03, 0.32, x, y + oy, z + oz, RZ(HALF), 6);
    else b.cyl('steel', 0.03, 0.32, x + oy, y, z + oz, undefined, 6);
  }
}

function buildManifold(materials: Record<MatKey, Material>, quality: GraphicsQuality): Group {
  const g = new Group();
  g.name = 'manifold';
  const b = new Builder();
  const { x: L, y: H, z: W } = MANIFOLD.size;
  const hl = L / 2;
  const hw = W / 2;
  // Mudmat foundation.
  b.box('concrete', L + 0.6, 0.35, W + 0.6, 0, 0.12, 0);
  // Protective frame: corner and mid columns.
  const cols: [number, number][] = [];
  for (const x of [-hl, -hl / 3, hl / 3, hl]) for (const z of [-hw, hw]) cols.push([x, z]);
  for (const [x, z] of cols) b.box('paint', 0.32, H, 0.32, x, H / 2, z);
  // Perimeter beams (top, mid, bottom).
  for (const y of [0.45, H * 0.55, H - 0.15]) {
    b.box('paint', L, 0.26, 0.26, 0, y, -hw);
    b.box('paint', L, 0.26, 0.26, 0, y, hw);
    b.box('paint', 0.26, 0.26, W, -hl, y, 0);
    b.box('paint', 0.26, 0.26, W, hl, y, 0);
  }
  // Roof: inclined fishing-friendly beams.
  for (let i = 0; i <= 6; i++) {
    const x = -hl + (i / 6) * L;
    b.box('paint', 0.18, 0.18, W, x, H, 0);
  }
  // Diagonal bracing on long sides (leaving a window open on the jumper side).
  for (const z of [-hw, hw]) {
    for (let i = 0; i < 3; i++) {
      const x0 = -hl + (i * L) / 3;
      const x1 = x0 + L / 3;
      if (z < 0 && i === 0) continue;
      b.beam('paint', new Vector3(x0, 0.45, z), new Vector3(x1, H * 0.55, z), 0.16);
    }
  }
  // Production headers.
  for (const [y, z] of [
    [1.4, -0.8],
    [1.9, 0.8],
  ]) {
    b.cyl('pipe', 0.26, L - 1.2, 0, y, z, RZ(HALF), 20);
    // header supports
    for (const x of [-3.5, 0, 3.5]) b.box('steel', 0.3, y - 0.3, 0.5, x, (y - 0.3) / 2 + 0.3, z);
  }
  // Branch valves along the headers.
  for (const x of [-3, -1, 1, 3]) {
    valve(b, x, 2.45, -0.8, 1);
    valve(b, x + 0.6, 2.9, 0.8, 0.9);
    b.cyl('pipe', 0.12, 1.1, x, 1.9, -0.2, RX(HALF), 12);
  }
  // ROV control panel on the south face.
  b.box('dark', 2.4, 1.2, 0.12, 1.8, 1.4, hw + 0.25);
  for (let i = 0; i < 4; i++) {
    b.cyl('handle', 0.07, 0.3, 0.9 + i * 0.6, 1.55, hw + 0.42, RX(HALF), 10);
    b.box('handle', 0.28, 0.06, 0.06, 0.9 + i * 0.6, 1.55, hw + 0.58);
  }
  b.box('paint', 2.6, 0.12, 0.6, 1.8, 0.75, hw + 0.4);
  // Jumper connection hub (IP-01) on the west end, and spool to header.
  hub(b, -5.6, 2.1, -1.6, 'x', 0.17);
  b.cyl('pipe', 0.17, 2.4, -4.2, 2.1, -1.6, RZ(HALF), 16);
  b.cyl('pipe', 0.17, 0.9, -3.0, 1.75, -1.2, RX(0.9), 16);
  // Pipeline hub on the east end.
  hub(b, 5.9, 0.9, 0.8, 'x', PIPELINE_RADIUS);
  b.cyl('pipe', PIPELINE_RADIUS, 1.6, 4.9, 0.9, 0.8, RZ(HALF), 18);
  b.cyl('pipe', 0.2, 1.2, 4.2, 1.4, 0.8, undefined, 16);
  // Sacrificial anodes on the columns.
  if (quality !== 'low')
    for (const [x, z] of cols) {
      b.box('anode', 0.18, 0.7, 0.18, x + 0.26 * Math.sign(x || 1), 1.2, z);
      b.box('anode', 0.18, 0.7, 0.18, x + 0.26 * Math.sign(x || 1), 3.0, z);
    }
  // Lifting padeyes.
  for (const [x, z] of [
    [-hl, -hw],
    [hl, -hw],
    [-hl, hw],
    [hl, hw],
  ])
    b.add('steel', new TorusGeometry(0.16, 0.05, 6, 12), compose(x, H + 0.25, z));
  b.build(materials, g);

  // Identification board.
  const tag = new Mesh(new PlaneGeometry(2.2, 0.8), new MeshStandardMaterial({ map: makeLabelTexture('MF-01', { w: 512, h: 186 }), roughness: 0.6 }));
  tag.position.set(-1.8, 3.2, hw + 0.2);
  g.add(tag);

  g.position.set(MANIFOLD.position.x, MANIFOLD.position.y, MANIFOLD.position.z);
  g.rotation.y = MANIFOLD.yaw;
  return g;
}

function buildTree(materials: Record<MatKey, Material>): Group {
  const g = new Group();
  g.name = 'xmas-tree';
  const b = new Builder();
  const { x: L, y: H } = TREE.size;
  const h = L / 2;
  // Guide base & frame.
  b.box('concrete', L + 0.6, 0.3, L + 0.6, 0, 0.1, 0);
  for (const x of [-h, h]) for (const z of [-h, h]) b.box('paint', 0.22, H, 0.22, x, H / 2, z);
  for (const y of [0.4, H - 0.1]) {
    for (const s of [-h, h]) {
      b.box('paint', L, 0.2, 0.2, 0, y, s);
      b.box('paint', 0.2, 0.2, L, s, y, 0);
    }
  }
  // Wellhead + tree body.
  b.cyl('steel', 0.45, 1.6, 0, 1.0, 0, undefined, 24);
  b.box('steel', 1.4, 1.5, 1.2, 0, 2.4, 0);
  b.cyl('dark', 0.55, 0.5, 0, 3.4, 0, undefined, 24);
  b.cyl('paint', 0.62, 0.35, 0, 3.85, 0, undefined, 24); // tree cap
  // Valve actuators on the body.
  for (const [x, z, ry] of [
    [0.95, 0, 0],
    [-0.95, 0, 0],
    [0, 0.85, HALF],
  ] as [number, number, number][]) {
    b.cyl('dark', 0.24, 0.7, x, 2.4, z, new Euler(0, ry, HALF), 16);
    b.add('handle', new TorusGeometry(0.2, 0.03, 6, 16), compose(x * 1.4, 2.4, z * 1.4, new Euler(0, ry + HALF, 0)));
  }
  // Production wing to the jumper.
  b.cyl('pipe', 0.17, 1.6, 1.1, 2.6, 0.5, new Euler(0, -0.35, HALF), 16);
  hub(b, 1.9, 2.6, 0.6, 'x', 0.17);
  // ROV panel.
  b.box('dark', 1.6, 0.9, 0.1, 0, 1.6, -h - 0.05);
  for (let i = 0; i < 3; i++) b.cyl('handle', 0.06, 0.25, -0.5 + i * 0.5, 1.65, -h - 0.2, RX(HALF), 10);
  b.build(materials, g);
  const tag = new Mesh(new PlaneGeometry(1.4, 0.5), new MeshStandardMaterial({ map: makeLabelTexture('ANM-03', { w: 384, h: 136 }), roughness: 0.6 }));
  tag.position.set(0, 3.1, h + 0.13);
  g.add(tag);
  // The local frame of the hub must match the site data (world-space jumper start).
  g.position.set(TREE.position.x, TREE.position.y, TREE.position.z);
  g.rotation.y = TREE.yaw;
  return g;
}

function tube(path: V3[], radius: number, segPerPoint: number, radial: number, tension: 'catmullrom' | 'centripetal' = 'centripetal') {
  const curve = new CatmullRomCurve3(
    path.map((p) => new Vector3(p.x, p.y, p.z)),
    false,
    tension,
  );
  return { curve, geo: new TubeGeometry(curve, Math.max(8, path.length * segPerPoint), radius, radial, false) };
}

function buildPipes(materials: Record<MatKey, Material>, quality: GraphicsQuality): Group {
  const g = new Group();
  g.name = 'pipes';
  const radial = quality === 'low' ? 10 : 18;
  const pipeline = tube(PIPELINE_PATH, PIPELINE_RADIUS, quality === 'low' ? 2 : 4, radial);
  const pm = new Mesh(pipeline.geo, materials.pipe);
  pm.castShadow = pm.receiveShadow = true;
  g.add(pm);
  const jumper = tube(JUMPER_PATH, JUMPER_RADIUS, 10, radial);
  const jm = new Mesh(jumper.geo, materials.dark);
  jm.castShadow = jm.receiveShadow = true;
  g.add(jm);

  const b = new Builder();
  // Field joints every ~12 m along the pipeline, anode bracelets every ~48 m.
  const len = pipeline.curve.getLength();
  for (let s = 6; s < len - 2; s += 12) {
    const t = s / len;
    const p = pipeline.curve.getPointAt(t);
    const d = pipeline.curve.getTangentAt(t);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d);
    const anode = Math.round(s / 12) % 4 === 0;
    const geo = new CylinderGeometry(PIPELINE_RADIUS * (anode ? 1.16 : 1.05), PIPELINE_RADIUS * (anode ? 1.16 : 1.05), anode ? 0.5 : 0.35, radial);
    b.add(anode ? 'anode' : 'concrete', geo, new Matrix4().compose(p, q, new Vector3(1, 1, 1)));
  }
  // Jumper supports? none (spans freely). Strakes (buoyancy marks) every 2 m on jumper.
  const jl = jumper.curve.getLength();
  for (let s = 1; s < jl - 1; s += 2.2) {
    const t = s / jl;
    const p = jumper.curve.getPointAt(t);
    const d = jumper.curve.getTangentAt(t);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d);
    b.add('paint', new CylinderGeometry(JUMPER_RADIUS * 1.12, JUMPER_RADIUS * 1.12, 0.25, radial), new Matrix4().compose(p, q, new Vector3(1, 1, 1)));
  }
  // PLET at the pipeline end.
  const { x: L, y: H, z: W } = PLET.size;
  const plet = new Builder();
  plet.box('concrete', L + 0.4, 0.3, W + 0.4, 0, 0.12, 0);
  for (const x of [-L / 2, L / 2]) for (const z of [-W / 2, W / 2]) plet.box('paint', 0.2, H, 0.2, x, H / 2, z);
  for (const s of [-1, 1]) {
    plet.box('paint', L, 0.18, 0.18, 0, H, (s * W) / 2);
    plet.box('paint', 0.18, 0.18, W, (s * L) / 2, H, 0);
  }
  valve(plet, 0, 0.8, 0, 1);
  plet.cyl('pipe', PIPELINE_RADIUS, L, 0, 0.6, 0, RZ(HALF), radial);
  const pletGroup = new Group();
  plet.build(materials, pletGroup);
  pletGroup.position.set(PLET.position.x, PLET.position.y, PLET.position.z);
  g.add(pletGroup);
  b.build(materials, g);
  return g;
}

/** Numbered inspection tags fixed on the structures, as used in real inspection campaigns. */
function buildMarkers(): Group {
  const g = new Group();
  g.name = 'inspection-markers';
  INSPECTION_POINTS.forEach((ip) => {
    const tex = makeLabelTexture(ip.id, { w: 256, h: 128, bg: '#f2f2ee', fg: '#111' });
    const plate = new Mesh(new PlaneGeometry(0.5, 0.25), new MeshStandardMaterial({ map: tex, roughness: 0.5, side: DoubleSide }));
    const look = new Vector3(ip.target.x + ip.approach.x, ip.target.y + ip.approach.y, ip.target.z + ip.approach.z);
    if (ip.id === 'IP-02') {
      // Tag on a small stake on the seabed beside the free span.
      const base = new Vector3(ip.target.x + ip.approach.x * 1.6, 0, ip.target.z + ip.approach.z * 1.6);
      base.y = terrainHeight(base.x, base.z);
      const stake = new Mesh(new CylinderGeometry(0.03, 0.03, 0.9, 6), new MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6 }));
      stake.position.copy(base).add(new Vector3(0, 0.45, 0));
      g.add(stake);
      plate.position.copy(base).add(new Vector3(0, 0.9, 0));
      plate.lookAt(new Vector3(look.x, plate.position.y, look.z));
    } else {
      // Tag above and beside the hub so it does not hide the connection.
      const side = new Vector3(-ip.approach.z, 0, ip.approach.x).normalize();
      plate.position.set(ip.target.x + ip.approach.x * 0.3 + side.x * 0.75, ip.target.y + 0.75, ip.target.z + ip.approach.z * 0.3 + side.z * 0.75);
      plate.lookAt(look.x, plate.position.y, look.z);
    }
    g.add(plate);
  });
  return g;
}

export function createStructures(quality: GraphicsQuality): Group {
  const root = new Group();
  root.name = 'structures';
  const materials = makeMaterials();
  root.add(buildManifold(materials, quality));
  root.add(buildTree(materials));
  root.add(buildPipes(materials, quality));
  root.add(buildMarkers());
  // Debug info: free span height is part of the site description.
  root.userData.freeSpanGap = FREE_SPAN.gap;
  return root;
}

export const STRUCTURE_COLORS = { paint: new Color(0xd9a21b) };
