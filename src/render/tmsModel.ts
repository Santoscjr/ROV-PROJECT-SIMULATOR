import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeLabelTexture } from './materials';

/**
 * Procedural Tether Management System (training approximation of a
 * cage-style TMS hanging from the main umbilical): open protective frame,
 * horizontal tether drum with hydraulic drive, level-wind carriage, bottom
 * bellmouth/fairlead with rollers, umbilical termination with bend restrictor,
 * and a monitoring camera with lamps aimed at the drum and the cable path.
 *
 * Local frame: origin at the centre, +Y up; drum axis along Z.
 * The tether leaves through the fairlead at `exitPoint` (0, −1.45, 0).
 */

export interface TmsModel {
  root: Group;
  drum: Object3D;
  setDrumAngle(rad: number): void;
  setStoredFraction(f: number): void;
  setLevelWind(x: number): void;
  exitPoint: Object3D;
  liftPoint: Object3D;
  /** Camera pose: local −Z is the view direction (like a three.js camera). */
  cameraMount: Object3D;
  lightMounts: Object3D[];
  dispose(): void;
}

const DRUM_Y = 0.45;
const CORE_R = 0.32;
const FLANGE_R = 0.7;
const DRUM_HALF = 0.72;
const LW_X = 0.95;
const LW_Y = -0.35;
const EXIT_Y = -1.45;

type Key = 'paint' | 'dark' | 'steel' | 'orange' | 'rubber';

class Parts {
  private parts = new Map<Key, BufferGeometry[]>();
  add(k: Key, g: BufferGeometry, x = 0, y = 0, z = 0, rot?: Euler): void {
    const geo = (g.index ? g.toNonIndexed() : g).clone();
    for (const n of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(n)) geo.deleteAttribute(n);
    geo.applyMatrix4(new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(rot ?? new Euler()), new Vector3(1, 1, 1)));
    const l = this.parts.get(k) ?? [];
    l.push(geo);
    this.parts.set(k, l);
  }
  box(k: Key, sx: number, sy: number, sz: number, x: number, y: number, z: number, rot?: Euler): void {
    this.add(k, new BoxGeometry(sx, sy, sz), x, y, z, rot);
  }
  cyl(k: Key, r: number, h: number, x: number, y: number, z: number, rot?: Euler, seg = 16): void {
    this.add(k, new CylinderGeometry(r, r, h, seg), x, y, z, rot);
  }
  beam(k: Key, a: Vector3, b: Vector3, size: number): void {
    const d = new Vector3().subVectors(b, a);
    const geo = new BoxGeometry(size, d.length(), size);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize());
    geo.applyQuaternion(q);
    const m = a.clone().add(b).multiplyScalar(0.5);
    this.add(k, geo, m.x, m.y, m.z);
  }
  build(mats: Record<Key, Material>, parent: Object3D): void {
    for (const [k, list] of this.parts) {
      const g = mergeGeometries(list, false);
      if (!g) continue;
      const mesh = new Mesh(g, mats[k]);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
    }
  }
}

function cableTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1b1d1f';
  ctx.fillRect(0, 0, 256, 64);
  // Wraps (dark grooves) and a yellow tracer every few turns so rotation reads on camera.
  for (let x = 0; x < 256; x += 8) {
    ctx.fillStyle = '#0c0d0e';
    ctx.fillRect(x, 0, 2, 64);
  }
  ctx.fillStyle = '#c9a227';
  ctx.fillRect(0, 26, 256, 6);
  ctx.fillStyle = '#e8e8e8';
  for (let x = 4; x < 256; x += 64) ctx.fillRect(x, 0, 3, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1, 3);
  return t;
}

export function createTmsModel(opts: { quality?: 'low' | 'medium' | 'high' } = {}): TmsModel {
  const seg = opts.quality === 'low' ? 12 : 24;
  const root = new Group();
  root.name = 'tms';
  const mats: Record<Key, Material> = {
    paint: new MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6, metalness: 0.15 }),
    dark: new MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.55, metalness: 0.45 }),
    steel: new MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.75 }),
    orange: new MeshStandardMaterial({ color: 0xd2621e, roughness: 0.55, metalness: 0.15 }),
    rubber: new MeshStandardMaterial({ color: 0x151617, roughness: 0.9 }),
  };
  const P = new Parts();
  const hx = 1.45;
  const hz = 1.05;
  const top = 1.3;
  const bot = -1.3;
  // Frame: posts, rails, braces.
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) P.box('paint', 0.14, top - bot, 0.14, x, 0, z);
  for (const y of [bot, -0.2, top]) {
    for (const z of [-hz, hz]) P.box('paint', 2 * hx, 0.12, 0.12, 0, y, z);
    for (const x of [-hx, hx]) P.box('paint', 0.12, 0.12, 2 * hz, x, y, 0);
  }
  for (const z of [-hz, hz]) {
    P.beam('paint', new Vector3(-hx, bot, z), new Vector3(0, -0.2, z), 0.09);
    P.beam('paint', new Vector3(hx, bot, z), new Vector3(0, -0.2, z), 0.09);
  }
  // Side guard bars (upper section), sparse so the drum stays visible.
  for (const z of [-hz, hz]) for (let x = -1.0; x <= 1.0; x += 0.5) P.box('paint', 0.05, 1.5, 0.05, x, 0.55, z);
  // Top deck beams + lifting bail + umbilical termination.
  for (const x of [-0.9, 0, 0.9]) P.box('paint', 0.14, 0.12, 2 * hz, x, top, 0);
  P.box('dark', 0.9, 0.08, 0.9, 0, top + 0.08, 0);
  P.add('steel', new TorusGeometry(0.35, 0.05, 8, seg, Math.PI), 0, top + 0.12, 0, new Euler(0, Math.PI / 2, 0));
  P.cyl('dark', 0.16, 0.35, 0, top + 0.3, 0.25, undefined, seg);
  P.add('rubber', new CylinderGeometry(0.035, 0.14, 0.9, seg), 0, top + 0.92, 0.25);
  // Drum supports (bearing plates) at both ends.
  for (const z of [-DRUM_HALF - 0.12, DRUM_HALF + 0.12]) {
    P.box('paint', 0.5, 1.05, 0.08, 0, DRUM_Y + 0.1, z);
    P.cyl('steel', 0.1, 0.12, 0, DRUM_Y, z, new Euler(Math.PI / 2, 0, 0), seg);
  }
  // Hydraulic drive (motor + gearbox) on the +Z end.
  P.box('dark', 0.42, 0.42, 0.3, 0, DRUM_Y, DRUM_HALF + 0.35);
  P.cyl('dark', 0.15, 0.45, 0, DRUM_Y + 0.05, DRUM_HALF + 0.72, new Euler(Math.PI / 2, 0, 0), seg);
  P.cyl('steel', 0.025, 0.6, 0.12, DRUM_Y - 0.3, DRUM_HALF + 0.5, new Euler(0.4, 0, 0), 6);
  // Hydraulic valve pack + junction box on the bottom deck.
  P.box('orange', 0.6, 0.3, 0.45, -0.8, bot + 0.22, -0.55);
  P.box('dark', 0.45, 0.35, 0.3, 0.85, bot + 0.25, 0.6);
  // Level-wind rail and screw (parallel to the drum axis).
  P.box('steel', 0.08, 0.08, 2 * DRUM_HALF + 0.3, LW_X, LW_Y + 0.12, 0);
  P.cyl('steel', 0.03, 2 * DRUM_HALF + 0.3, LW_X, LW_Y - 0.06, 0, new Euler(Math.PI / 2, 0, 0), 8);
  // Bottom deck and bellmouth / fairlead with rollers.
  P.box('paint', 0.9, 0.08, 0.9, 0, bot, 0);
  P.add('steel', new CylinderGeometry(0.12, 0.3, 0.3, seg, 1, true), 0, bot - 0.08, 0);
  P.add('steel', new TorusGeometry(0.3, 0.03, 6, seg), 0, bot - 0.23, 0, new Euler(Math.PI / 2, 0, 0));
  for (const [x, z, ry] of [
    [0.13, 0, 0],
    [-0.13, 0, 0],
    [0, 0.13, Math.PI / 2],
    [0, -0.13, Math.PI / 2],
  ] as [number, number, number][])
    P.cyl('rubber', 0.045, 0.24, x, bot + 0.06, z, new Euler(Math.PI / 2, ry, 0), 10);
  // Anodes.
  for (const x of [-hx, hx]) P.box('steel', 0.14, 0.5, 0.14, x * 0.97, -0.75, hz * 0.97);
  // Camera housing (lower −X/+Z corner) and lamp brackets.
  const camPos = new Vector3(-1.2, -0.95, 0.82);
  P.cyl('dark', 0.08, 0.3, camPos.x + 0.1, camPos.y, camPos.z, new Euler(0, 0, Math.PI / 2), 12);
  P.box('paint', 0.12, 0.35, 0.12, camPos.x - 0.05, camPos.y - 0.2, camPos.z);
  P.build(mats, root);

  // Label.
  const label = new Mesh(new PlaneGeometry(0.9, 0.35), new MeshStandardMaterial({ map: makeLabelTexture('TMS-1', { w: 256, h: 100 }), roughness: 0.6 }));
  label.position.set(0, -0.55, hz + 0.08);
  root.add(label);

  // Drum (rotating): core, flanges, stored cable.
  const drum = new Group();
  drum.position.set(0, DRUM_Y, 0);
  root.add(drum);
  const drumParts = new Parts();
  drumParts.cyl('orange', CORE_R, 2 * DRUM_HALF, 0, 0, 0, new Euler(Math.PI / 2, 0, 0), seg);
  for (const z of [-DRUM_HALF, DRUM_HALF]) {
    drumParts.cyl('orange', FLANGE_R, 0.04, 0, 0, z, new Euler(Math.PI / 2, 0, 0), seg * 2);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      drumParts.box('dark', 0.05, FLANGE_R * 0.9, 0.05, Math.cos(a) * FLANGE_R * 0.45, Math.sin(a) * FLANGE_R * 0.45, z + Math.sign(z) * 0.03, new Euler(0, 0, a + Math.PI / 2));
    }
  }
  drumParts.cyl('steel', 0.07, 2 * DRUM_HALF + 0.35, 0, 0, 0, new Euler(Math.PI / 2, 0, 0), 10);
  drumParts.build(mats, drum);
  const cableTex = cableTexture();
  const cableMat = new MeshStandardMaterial({ map: cableTex, roughness: 0.55, metalness: 0.1 });
  const wrap = new Mesh(new CylinderGeometry(1, 1, 2 * DRUM_HALF - 0.06, seg * 2, 1, false), cableMat);
  wrap.rotation.x = Math.PI / 2;
  wrap.castShadow = wrap.receiveShadow = true;
  drum.add(wrap);

  // Level-wind carriage (moves along Z).
  const carriage = new Group();
  carriage.position.set(LW_X, LW_Y, 0);
  root.add(carriage);
  const cP = new Parts();
  cP.box('dark', 0.22, 0.16, 0.2, 0, 0, 0);
  cP.cyl('rubber', 0.05, 0.22, 0, -0.1, 0.06, new Euler(0, 0, Math.PI / 2), 10);
  cP.cyl('rubber', 0.05, 0.22, 0, -0.1, -0.06, new Euler(0, 0, Math.PI / 2), 10);
  cP.build(mats, carriage);

  // Cable path inside the TMS: drum → level wind → fairlead (two dynamic spans).
  const spanGeo = new CylinderGeometry(0.018, 0.018, 1, 6, 1);
  const spanA = new Mesh(spanGeo, mats.rubber);
  const spanB = new Mesh(spanGeo, mats.rubber);
  root.add(spanA, spanB);
  const placeSpan = (m: Mesh, a: Vector3, b: Vector3) => {
    const d = new Vector3().subVectors(b, a);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize());
    m.scale.set(1, d.length(), 1);
  };
  let radius = CORE_R + 0.05;
  let lw = 0;
  const updateSpans = () => {
    const z = lw * (DRUM_HALF - 0.12);
    const tangent = new Vector3(radius * 0.94, DRUM_Y - radius * 0.34, z);
    const roller = new Vector3(LW_X, LW_Y - 0.1, z);
    placeSpan(spanA, tangent, roller);
    placeSpan(spanB, roller, new Vector3(0, bot - 0.05, 0));
  };

  // Anchors for the caller.
  const exitPoint = new Object3D();
  exitPoint.position.set(0, EXIT_Y, 0);
  const liftPoint = new Object3D();
  liftPoint.position.set(0, top + 1.37, 0.25);
  const cameraMount = new Object3D();
  cameraMount.position.copy(camPos).add(new Vector3(0.26, 0, 0));
  root.add(exitPoint, liftPoint, cameraMount);
  // Aim at a point between the drum and the level wind (frames drum, carriage and fairlead path).
  cameraMount.lookAt(new Vector3(0.45, DRUM_Y - 0.55, 0));
  cameraMount.rotateY(Math.PI); // lookAt points +Z; cameras look along −Z
  const lightMounts: Object3D[] = [];
  for (const dz of [-0.22, 0.22]) {
    const m = new Object3D();
    m.position.copy(camPos).add(new Vector3(0.15, 0.22, dz));
    root.add(m);
    m.lookAt(new Vector3(0.3, DRUM_Y, 0));
    m.rotateY(Math.PI);
    lightMounts.push(m);
    const lamp = new Mesh(new CylinderGeometry(0.05, 0.05, 0.08, 10), new MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2d8, emissiveIntensity: 2 }));
    lamp.rotation.x = Math.PI / 2;
    m.add(lamp);
  }

  const model: TmsModel = {
    root,
    drum,
    setDrumAngle(rad) {
      drum.rotation.z = -rad;
    },
    setStoredFraction(f) {
      radius = CORE_R + 0.02 + (FLANGE_R * 0.9 - CORE_R) * Math.min(1, Math.max(0, f));
      wrap.scale.set(radius, 1, radius);
      wrap.visible = f > 0.002;
      updateSpans();
    },
    setLevelWind(x) {
      lw = Math.min(1, Math.max(-1, x));
      carriage.position.z = lw * (DRUM_HALF - 0.12);
      updateSpans();
    },
    exitPoint,
    liftPoint,
    cameraMount,
    lightMounts,
    dispose() {
      root.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        const mat = m.material as MeshStandardMaterial | undefined;
        mat?.map?.dispose();
        mat?.dispose();
      });
    },
  };
  model.setStoredFraction(0.8);
  return model;
}
