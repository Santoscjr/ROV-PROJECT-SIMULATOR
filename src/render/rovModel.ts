/**
 * Procedural 3D model of the simulated offshore work-class ROV "WC-150"
 * (fictional, original design). ~2.6 m L × 1.6 m W × 1.6 m H.
 *
 * Frame: body frame of the simulator — +X forward (bow), +Y up, +Z starboard,
 * origin at the centre of gravity. Thrusters are placed exactly at
 * `THRUSTERS[i].position` with the duct axis along `THRUSTERS[i].direction`.
 *
 * Draw-call budget: all static geometry is merged per material (8 meshes),
 * plus 8 propellers, the pilot camera tilt head (2 meshes) and one mesh per
 * manipulator joint (7 + 5) → 30 draw calls in every quality level.
 */
import * as THREE from 'three';
import { THRUSTERS } from '../physics/rovParams';
import {
  Adder,
  DUCT_RI,
  Detail,
  GeoSet,
  LABEL_V0,
  STRIPE_V1,
  MAT_KEYS,
  MatKey,
  PILOT_DOME_R,
  PILOT_DOME_X,
  POD_END,
  T,
  TQ,
  V3,
  beam,
  buildArm,
  createMaterials,
  cyl,
  detailFor,
  hose,
  lathe,
  lightHead,
  mul,
  pilotCameraHead,
  pilotDome,
  propellerGeometry,
  rbox,
  smallCamera,
  sub,
  thrusterStatic,
} from './rovModelParts';

export type Quality = 'low' | 'medium' | 'high';

export interface ArmRig {
  /** Fixed mounting frame of the arm (child of root). */
  base: THREE.Object3D;
  /**
   * Joint pivots from base to jaw. Each joint's `userData` = `{ axis, rest }`:
   * rotate about the local `axis` ('x'|'y'|'z'); `rest` is the stowed angle.
   * Starboard 7-function: azimuth(y), shoulder(z), elbow(z), wristPitch(z),
   * wristYaw(y), wristRotate(x), jaw(z).
   * Port 5-function grabber: azimuth(y), shoulder(z), elbow(z), wristRotate(x), jaw(z).
   */
  joints: THREE.Object3D[];
}

export interface RovModel {
  root: THREE.Group;
  /**
   * Same order as THRUSTERS. Each propeller spins about its LOCAL +Y axis,
   * which is aligned with the thruster `direction`. Prefer `setThrust`.
   */
  propellers: THREE.Object3D[];
  /** levels in [-1,1] per thruster (same order as THRUSTERS); spins props up to 25 rev/s. */
  setThrust(levels: readonly number[], dt: number): void;
  /** Pan/tilt head. Rotating about its local Z tilts the camera; local +X is the view direction at tilt 0. */
  cameraTilt: THREE.Object3D;
  /** Point just in front of the dome glass (child of cameraTilt), looking along local +X. */
  cameraEye: THREE.Object3D;
  /** One per light head (upper port, upper stbd, lower port, lower stbd); local +X is the beam direction. */
  lightMounts: THREE.Object3D[];
  /** 0..1 makes lamp lenses emissive accordingly. */
  setLightLevel(level: number): void;
  tetherPoint: THREE.Object3D;
  manipulators: { port: ArmRig; starboard: ArmRig };
  dispose(): void;
}

// --- Layout constants (m) ----------------------------------------------------
const SZ = 0.72; // side frame plane |z|
const TOPY = 0.02; // top rail centre height
const SKY = -0.8; // skid centre height
const XF = 1.18; // front / aft post |x|
const XM = 0.42; // mid post |x|
const FOAM_Y0 = 0.06;
const FOAM_Y1 = 0.7;
const FOAM_HW = 0.725; // foam half width incl. bevel
const MAX_REV_S = 25;

export function createRovModel(opts: { quality?: Quality; envMap?: THREE.Texture | null } = {}): RovModel {
  const d = detailFor(opts.quality ?? 'high');
  const { mats, dome: domeMat, textures } = createMaterials(opts.envMap ?? null);
  const sets = Object.fromEntries(MAT_KEYS.map((k) => [k, new GeoSet()])) as Record<MatKey, GeoSet>;
  const add: Adder = (k, g, m, c) => sets[k].add(g, m, c);

  const root = new THREE.Group();
  root.name = 'WC-150';

  buildFrame(add, d);
  buildFoam(add, d);
  const propellers = buildThrusters(add, d, root, mats.metal);
  buildSystems(add, d);
  const lightMounts = buildLights(add, d, root);
  buildSensors(add, d);
  const tetherPoint = buildTopside(add, d, root);

  // Pilot camera pan/tilt
  const pan = new THREE.Vector3(1.16, -0.03, 0);
  add('paint', cyl(0.056, 0.056, 0.075, d.radial), T(pan.x, pan.y, 0), 0x2f3338);
  add('paint', cyl(0.06, 0.06, 0.012, d.radial), T(pan.x, pan.y - 0.04, 0), 0x1b1d20);
  add('frame', rbox(0.08, 0.025, 0.21, 0.008, d.round), T(pan.x, pan.y - 0.055, 0));
  for (const s of [1, -1]) add('frame', rbox(0.06, 0.13, 0.016, 0.006, d.round), T(pan.x, pan.y - 0.12, s * 0.097));
  const cameraTilt = new THREE.Object3D();
  cameraTilt.name = 'pilot-camera-tilt';
  cameraTilt.position.set(pan.x, pan.y - 0.15, 0);
  root.add(cameraTilt);
  const headMesh = new THREE.Mesh(pilotCameraHead(new GeoSet(), d), mats.paint);
  const domeMesh = new THREE.Mesh(pilotDome(d), domeMat);
  domeMesh.renderOrder = 2;
  cameraTilt.add(headMesh, domeMesh);
  const cameraEye = new THREE.Object3D();
  cameraEye.name = 'pilot-camera-eye';
  cameraEye.position.set(PILOT_DOME_X + PILOT_DOME_R + 0.02, 0, 0);
  cameraTilt.add(cameraEye);

  // Manipulators (front lower, stowed)
  const starboard = buildArm('starboard', d, mats.paint);
  const port = buildArm('port', d, mats.paint);
  for (const [arm, s] of [[starboard, 1], [port, -1]] as const) {
    arm.base.position.set(1.0, -0.6, s * 0.3);
    root.add(arm.base);
    add('frame', rbox(0.16, 0.17, 0.16, 0.015, d.round), T(1.0, -0.69, s * 0.3));
    beam(add, 'frame', [1.0, -0.72, s * 0.3], [XF, -0.62, s * 0.3], 0.06, 0.06, d.round);
  }

  // Merge static buckets
  const staticMeshes: THREE.Mesh[] = [];
  for (const k of MAT_KEYS) {
    if (sets[k].empty) continue;
    const mesh = new THREE.Mesh(sets[k].build(), mats[k]);
    mesh.name = `rov-static-${k}`;
    if (k === 'label') mesh.renderOrder = 1;
    staticMeshes.push(mesh);
    root.add(mesh);
  }
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  domeMesh.castShadow = false;

  const angles = new Float64Array(propellers.length);
  const setThrust = (levels: readonly number[], dt: number) => {
    for (let i = 0; i < propellers.length; i++) {
      const l = Math.max(-1, Math.min(1, levels[i] ?? 0));
      angles[i] = (angles[i] + l * MAX_REV_S * Math.PI * 2 * dt) % (Math.PI * 2);
      propellers[i].rotation.y = angles[i];
    }
  };

  const setLightLevel = (level: number) => {
    const l = Math.max(0, Math.min(1, level));
    mats.lens.emissiveIntensity = l * 6;
    mats.lens.color.setScalar(0.55 + 0.45 * l);
  };
  setLightLevel(0);

  const dispose = () => {
    const geos = new Set<THREE.BufferGeometry>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) geos.add(m.geometry);
    });
    geos.forEach((g) => g.dispose());
    for (const k of MAT_KEYS) mats[k].dispose();
    domeMat.dispose();
    textures.forEach((t) => t.dispose());
  };

  return {
    root,
    propellers,
    setThrust,
    cameraTilt,
    cameraEye,
    lightMounts,
    setLightLevel,
    tetherPoint,
    manipulators: { port, starboard },
    dispose,
  };
}

// ---------------------------------------------------------------------------

function buildFrame(add: Adder, d: Detail): void {
  const R = d.round;
  for (const s of [-1, 1]) {
    const z = s * SZ;
    beam(add, 'frame', [-XF - 0.03, TOPY, z], [XF + 0.03, TOPY, z], 0.06, 0.08, R);
    beam(add, 'frame', [-0.98, SKY, z], [0.98, SKY, z], 0.08, 0.09, R);
    beam(add, 'frame', [0.96, SKY + 0.005, z], [XF + 0.01, -0.63, z], 0.08, 0.09, R);
    beam(add, 'frame', [-0.96, SKY + 0.005, z], [-XF - 0.01, -0.63, z], 0.08, 0.09, R);
    for (const x of [XF, -XF]) beam(add, 'frame', [x, -0.66, z], [x, TOPY + 0.03, z], 0.06, 0.07, R);
    for (const x of [XM, -XM]) beam(add, 'frame', [x, SKY, z], [x, TOPY, z], 0.06, 0.07, R);
    beam(add, 'frame', [-XM, -0.36, z], [XM, -0.36, z], 0.05, 0.06, R);
    beam(add, 'frame', [-XM + 0.03, SKY + 0.03, z], [XM - 0.03, -0.38, z], 0.05, 0.05, R);
    beam(add, 'frame', [-XM + 0.03, -0.34, z], [XM - 0.03, TOPY - 0.02, z], 0.05, 0.05, R);
    // HDPE rubbing strips and skid shoes
    add('rubber', rbox(2.1, 0.055, 0.03, 0.01, R), T(0, TOPY, s * (SZ + 0.045)));
    add('rubber', rbox(0.8, 0.05, 0.03, 0.01, R), T(0, -0.36, s * (SZ + 0.04)));
    add('rubber', rbox(1.9, 0.035, 0.1, 0.012, R), T(0, SKY - 0.062, z));
    // Corner bumpers
    for (const x of [XF, -XF]) {
      add('rubber', rbox(0.1, 0.16, 0.1, 0.03, R), T(x, TOPY + 0.0, z));
      add('rubber', rbox(0.1, 0.12, 0.1, 0.03, R), T(x, -0.62, z));
    }
  }
  // Cross members (along Z)
  for (const x of [XF, -XF, 0.95, -0.95, 0.48, -0.48, 0]) {
    beam(add, 'frame', [x, TOPY, -SZ + 0.03], [x, TOPY, SZ - 0.03], 0.06, 0.07, R);
  }
  for (const [x, y] of [[0.95, SKY], [-0.95, SKY], [0, SKY], [XF, -0.64], [-XF, -0.64]] as const) {
    beam(add, 'frame', [x, y, -SZ + 0.03], [x, y, SZ - 0.03], 0.06, 0.07, R);
  }
  // Tool skid platform
  add('frame', rbox(1.5, 0.025, 1.0, 0.008, R), T(-0.1, -0.69, 0));
  for (const x of [-0.75, 0.55]) for (const z of [-0.45, 0.45]) beam(add, 'frame', [x, -0.7, z], [x, SKY, z], 0.04, 0.04, R);
  // Anodes
  const anode = (x: number, y: number, z: number, ry = 0) => {
    add('metal', rbox(0.15, 0.045, 0.05, 0.01, R), T(x, y, z, 0, ry, 0), 0xa9aeb3);
    add('metal', rbox(0.03, 0.02, 0.015, 0.003, 1), T(x - 0.06, y - 0.03, z, 0, ry, 0), 0x6d7378);
    add('metal', rbox(0.03, 0.02, 0.015, 0.003, 1), T(x + 0.06, y - 0.03, z, 0, ry, 0), 0x6d7378);
  };
  for (const s of [-1, 1]) {
    anode(0.6, SKY + 0.07, s * SZ);
    anode(-0.6, SKY + 0.07, s * SZ);
    anode(-XF, -0.25, s * 0.35, Math.PI / 2);
  }
}

/** Sloped nose / tail of the buoyancy: [start x, end x, drop at the end]. */
const FOAM_NOSE: [number, number, number] = [0.9, XF + 0.04, 0.16];
const FOAM_TAIL: [number, number, number] = [-0.95, -XF - 0.04, 0.1];

function foamDrop(x: number): number {
  for (const [xs, xe, drop] of [FOAM_NOSE, FOAM_TAIL]) {
    const t = (x - xs) / (xe - xs);
    if (t > 0) return drop * t;
  }
  return 0;
}

/** Height of the foam top surface at x (flat part = FOAM_Y1). */
export function foamTop(x: number): number {
  return FOAM_Y1 - foamDrop(x);
}

/** Shears the top of the foam down towards the nose / tail, transforming normals consistently. */
function shearFoam(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const h = FOAM_Y1 - FOAM_Y0;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    let a = 0;
    let s = 0;
    for (const [xs, xe, drop] of [FOAM_NOSE, FOAM_TAIL]) {
      const t = (x - xs) / (xe - xs);
      if (t > 0) {
        s = drop * t;
        a = -(drop / (xe - xs)) * ((y - FOAM_Y0) / h);
      }
    }
    if (s === 0) continue;
    const b = 1 - s / h;
    pos.setY(i, y - (s * (y - FOAM_Y0)) / h);
    n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
    n.set(n.x - (a / b) * n.y, n.y / b, n.z).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
}

function foamBlock(add: Adder, d: Detail, x0: number, x1: number, holes: [number, number][], rOut: number, rIn: [number, number]): void {
  const bev = 0.03;
  const zH = FOAM_HW - bev;
  const a = x0 + bev;
  const b = x1 - bev;
  // Plan view outline in (x, -z). rIn = [aft corner radius, fwd corner radius]
  const [ra, rf] = [rIn[0] || rOut, rIn[1] || rOut];
  const sh = new THREE.Shape();
  sh.moveTo(a + ra, -zH);
  sh.lineTo(b - rf, -zH);
  sh.quadraticCurveTo(b, -zH, b, -zH + rf);
  sh.lineTo(b, zH - rf);
  sh.quadraticCurveTo(b, zH, b - rf, zH);
  sh.lineTo(a + ra, zH);
  sh.quadraticCurveTo(a, zH, a, zH - ra);
  sh.lineTo(a, -zH + ra);
  sh.quadraticCurveTo(a, -zH, a + ra, -zH);
  for (const [hx, hz] of holes) {
    const p = new THREE.Path();
    p.absarc(hx, -hz, 0.2, 0, Math.PI * 2, true);
    sh.holes.push(p);
  }
  const depth = FOAM_Y1 - FOAM_Y0 - 2 * bev;
  const g = new THREE.ExtrudeGeometry(sh, {
    depth,
    bevelEnabled: true,
    bevelThickness: bev,
    bevelSize: bev,
    bevelSegments: d.bevel,
    curveSegments: Math.max(4, d.radial >> 1),
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, FOAM_Y0 + bev, 0);
  shearFoam(g);
  add('foam', g);
}

/** Decal quad. Normal +Z rotated by ry; vRange selects atlas region. */
function decal(add: Adder, w: number, h: number, m: THREE.Matrix4, v0: number, v1: number): void {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, v0 + uv.getY(i) * (v1 - v0));
  add('label', g, m);
}

function buildFoam(add: Adder, d: Detail): void {
  foamBlock(add, d, 0.31, XF + 0.04, [[0.7, 0.5], [0.7, -0.5]], 0.14, [0.04, 0]);
  foamBlock(add, d, -0.29, 0.29, [], 0.04, [0, 0]);
  foamBlock(add, d, -XF - 0.04, -0.31, [[-0.7, 0.5], [-0.7, -0.5]], 0.14, [0, 0.04]);
  // Thruster guard grilles across the vertical thruster wells
  for (const x of [0.7, -0.7]) {
    for (const zc of [0.5, -0.5]) {
      for (const dz of [-0.08, 0, 0.08]) {
        const half = Math.sqrt(0.2 * 0.2 - dz * dz) + 0.02;
        add('frame', rbox(half * 2, 0.02, 0.014, 0.004, 1), T(x, FOAM_Y1 - 0.03, zc + dz));
      }
    }
  }
  // Name decals on both sides of the forward block, hazard stripes elsewhere
  const zS = FOAM_HW + 0.002;
  decal(add, 0.66, 0.226, T(0.72, 0.4, zS), LABEL_V0, 1);
  decal(add, 0.66, 0.226, T(0.72, 0.4, -zS, 0, Math.PI, 0), LABEL_V0, 1);
  for (const s of [1, -1]) {
    decal(add, 0.5, 0.06, T(-0.74, FOAM_Y1 - 0.09, s * zS, 0, s > 0 ? 0 : Math.PI, 0), 0, STRIPE_V1);
    decal(add, 0.4, 0.06, T(-XF - 0.042, FOAM_Y1 - 0.2, s * 0.36, 0, -Math.PI / 2, 0), 0, STRIPE_V1);
  }
  decal(add, 1.0, 0.06, T(XF + 0.042, FOAM_Y1 - 0.25, 0, 0, Math.PI / 2, 0), 0, STRIPE_V1);
}

function thrusterBasis(i: number): { pos: THREE.Vector3; q: THREE.Quaternion; dir: THREE.Vector3; up: THREE.Vector3; podSign: 1 | -1 } {
  const t = THRUSTERS[i];
  const pos = new THREE.Vector3(...t.position);
  const dir = new THREE.Vector3(...t.direction).normalize();
  const vertical = Math.abs(dir.y) > 0.7;
  // Local X: up for horizontal thrusters, bow for vertical ones (lugs at ±X).
  const xAxis = vertical ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  xAxis.sub(dir.clone().multiplyScalar(xAxis.dot(dir))).normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, dir);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, dir, zAxis));
  // Motor pod on the inboard side (down for verticals).
  let podSign: 1 | -1;
  if (vertical) podSign = dir.y > 0 ? -1 : 1;
  else podSign = Math.abs(pos.z + dir.z * POD_END) <= Math.abs(pos.z - dir.z * POD_END) ? 1 : -1;
  return { pos, q, dir, up: xAxis, podSign };
}

function buildThrusters(add: Adder, d: Detail, root: THREE.Group, propMat: THREE.Material): THREE.Object3D[] {
  const props: THREE.Object3D[] = [];
  const propGeos: Partial<Record<1 | -1, THREE.BufferGeometry>> = {};
  const R = d.round;
  for (let i = 0; i < THRUSTERS.length; i++) {
    const { pos, q, dir, up, podSign } = thrusterBasis(i);
    const m = TQ(pos, q);
    thrusterStatic(sub(add, m), podSign, d);

    const holder = new THREE.Object3D();
    holder.name = `thruster-${THRUSTERS[i].id}`;
    holder.position.copy(pos);
    holder.quaternion.copy(q);
    root.add(holder);
    const geo = (propGeos[podSign] ??= propellerGeometry(d, podSign));
    const prop = new THREE.Mesh(geo, propMat);
    prop.name = `propeller-${THRUSTERS[i].id}`;
    holder.add(prop);
    props.push(prop);

    // Lug positions in body frame
    const lug = (s: number) => pos.clone().addScaledVector(up, s * (DUCT_RI + 0.12)).addScaledVector(dir, -0.05);
    if (Math.abs(dir.y) < 0.7) {
      const top = lug(1);
      const bot = lug(-1);
      beam(add, 'frame', [top.x, top.y - 0.02, top.z], [top.x, TOPY, top.z], 0.05, 0.05, R);
      beam(add, 'frame', [bot.x, bot.y + 0.02, bot.z], [bot.x, SKY, bot.z], 0.05, 0.05, R);
    }
    // Power cable from the pod end to the junction box on that side
    const podEnd = pos.clone().addScaledVector(dir, podSign * (POD_END + 0.03));
    const out = podEnd.clone().addScaledVector(dir, podSign * 0.12);
    const side = Math.sign(pos.z);
    const jb = new THREE.Vector3(0.25 + (pos.x > 0 ? 0.06 : -0.06), -0.25, side * (0.36 + (Math.abs(dir.y) > 0.7 ? 0.03 : -0.03)));
    const mid = out.clone().lerp(jb, 0.5);
    mid.y = Math.min(mid.y, -0.15) - 0.05;
    hose(add, 'rubber', [podEnd.toArray() as V3, out.toArray() as V3, mid.toArray() as V3, [jb.x, jb.y + 0.05, jb.z], jb.toArray() as V3], 0.011, d);
  }
  return props;
}

function buildSystems(add: Adder, d: Detail): void {
  const R = d.round;
  const toX = T(0, 0, 0, 0, 0, -Math.PI / 2);
  // Electronics / telemetry pressure housings (titanium) along X
  for (const s of [-1, 1]) {
    const c = new THREE.Vector3(-0.1, -0.13, s * 0.29);
    const prof: [number, number][] = [
      [0, -0.62], [0.06, -0.62], [0.09, -0.6], [0.1, -0.57], [0.1, 0.5], [0.112, 0.505], [0.112, 0.55],
      [0.095, 0.56], [0.07, 0.585], [0, 0.59],
    ];
    add('metal', lathe(prof, d.radial), mul(T(c.x, c.y, c.z), toX), 0x8f969d);
    add('metal', cyl(0.113, 0.113, 0.04, d.radial), mul(T(c.x, c.y, c.z), toX, T(0, -0.5, 0)), 0x8f969d);
    for (const x of [-0.45, 0.3]) {
      add('frame', rbox(0.05, 0.12, 0.26, 0.01, R), T(x, -0.06, s * 0.29));
    }
    for (const k of [0, 1, 2]) {
      add('metal', cyl(0.014, 0.014, 0.04, d.small), mul(T(c.x + 0.69, c.y + (k - 1) * 0.04, c.z), toX), 0xb7a06a);
    }
    // Junction boxes
    add('paint', rbox(0.24, 0.13, 0.13, 0.02, R), T(0.25, -0.33, s * 0.36), 0x2b3036);
    add('paint', rbox(0.25, 0.015, 0.14, 0.004, 1), T(0.25, -0.26, s * 0.36), 0x484f57);
    for (const x of [0.19, 0.31]) add('metal', cyl(0.014, 0.014, 0.03, d.small), T(x, -0.24, s * 0.36), 0xb7a06a);
    // Compensators
    const cx = -0.72;
    const cz = s * 0.22;
    add('paint', cyl(0.075, 0.075, 0.26, d.radial), T(cx, -0.42, cz), 0xd8b024);
    add('paint', cyl(0.08, 0.08, 0.025, d.radial), T(cx, -0.28, cz), 0x24272b);
    add('paint', cyl(0.08, 0.08, 0.025, d.radial), T(cx, -0.56, cz), 0x24272b);
    add('metal', cyl(0.012, 0.012, 0.05, d.small), T(cx, -0.25, cz), 0xd0d5da);
    hose(add, 'rubber', [[cx, -0.23, cz], [cx + 0.05, -0.18, cz], [-0.4, -0.3, s * 0.05], [-0.35, -0.42, 0]], 0.012, d);
    // Hydraulic hoses to the manipulator bases
    hose(add, 'rubber', [[0.24, -0.47, s * 0.06], [0.42, -0.62, s * 0.12], [0.75, -0.66, s * 0.27], [0.93, -0.66, s * 0.27]], 0.014, d);
    hose(add, 'rubber', [[0.24, -0.5, s * 0.1], [0.45, -0.64, s * 0.17], [0.75, -0.7, s * 0.33], [0.93, -0.71, s * 0.33]], 0.012, d);
  }
  // Hydraulic power unit: electric motor + pump + manifold
  add('paint', lathe([[0, -0.38], [0.12, -0.38], [0.155, -0.36], [0.16, -0.32], [0.16, 0.12], [0.15, 0.14], [0, 0.14]], d.radial), mul(T(-0.17, -0.42, 0), toX), 0x3b5163);
  for (let k = 0; k < 7; k++) add('paint', cyl(0.165, 0.165, 0.012, d.radial), mul(T(-0.17, -0.42, 0), toX, T(0, -0.3 + k * 0.055, 0)), 0x34495a);
  add('paint', cyl(0.11, 0.12, 0.14, d.radial), mul(T(0.04, -0.42, 0), toX), 0x5b6670);
  add('paint', rbox(0.12, 0.2, 0.22, 0.015, R), T(0.17, -0.42, 0), 0x6f7a84);
  for (const z of [-0.06, 0, 0.06]) add('metal', cyl(0.015, 0.015, 0.04, d.small), mul(T(0.24, -0.4, z), toX), 0xd0d5da);
  add('frame', rbox(0.7, 0.03, 0.3, 0.008, R), T(-0.12, -0.6, 0));
  // Tool skid: valve packs + manifold
  add('paint', rbox(0.34, 0.1, 0.18, 0.015, R), T(-0.35, -0.625, 0.32), 0x2b3036);
  add('paint', rbox(0.34, 0.1, 0.18, 0.015, R), T(-0.35, -0.625, -0.32), 0x2b3036);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) add('metal', cyl(0.018, 0.018, 0.05, d.small), T(-0.47 + k * 0.08, -0.555, s * 0.32), 0xc0a45a);
  }
  add('paint', rbox(0.3, 0.09, 0.26, 0.015, R), T(-0.72, -0.63, 0), 0xc9661c);
}

function buildLights(add: Adder, d: Detail, root: THREE.Group): THREE.Object3D[] {
  const mounts: THREE.Object3D[] = [];
  const specs: { p: V3; yaw: number; pitch: number; stem: [V3, V3] }[] = [
    { p: [1.06, 0.74, -0.5], yaw: 0.06, pitch: -0.14, stem: [[1.01, foamTop(1.01) - 0.02, -0.5], [1.01, 0.72, -0.5]] },
    { p: [1.06, 0.74, 0.5], yaw: -0.06, pitch: -0.14, stem: [[1.01, foamTop(1.01) - 0.02, 0.5], [1.01, 0.72, 0.5]] },
    { p: [1.27, -0.5, -0.56], yaw: 0.05, pitch: -0.2, stem: [[XF, -0.5, -SZ], [1.22, -0.5, -0.56]] },
    { p: [1.27, -0.5, 0.56], yaw: -0.05, pitch: -0.2, stem: [[XF, -0.5, SZ], [1.22, -0.5, 0.56]] },
  ];
  const names = ['upper-port', 'upper-stbd', 'lower-port', 'lower-stbd'];
  specs.forEach((s, i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw, s.pitch, 'YZX'));
    const m = TQ(new THREE.Vector3(...s.p), q);
    lightHead(sub(add, m), d);
    beam(add, 'frame', s.stem[0], s.stem[1], 0.04, 0.04, d.round);
    add('frame', rbox(0.06, 0.05, 0.03, 0.006, 1), T(s.stem[1][0] + 0.0, s.stem[1][1], s.stem[1][2]));
    const mount = new THREE.Object3D();
    mount.name = `light-${names[i]}`;
    mount.position.set(...s.p);
    mount.quaternion.copy(q);
    mount.translateX(0.025);
    root.add(mount);
    mounts.push(mount);
  });
  return mounts;
}

function buildSensors(add: Adder, d: Detail): void {
  const R = d.round;
  // Secondary cameras under the front top cross member
  for (const s of [-1, 1]) {
    const m = T(1.21, -0.07, s * 0.44, 0, s * -0.1, -0.22);
    smallCamera(sub(add, m), d);
    add('frame', rbox(0.04, 0.08, 0.04, 0.008, 1), T(1.2, -0.02, s * 0.44));
  }
  // Rear camera
  smallCamera(sub(add, T(-XF - 0.08, -0.1, 0, 0, Math.PI, -0.1)), d);
  add('frame', rbox(0.1, 0.03, 0.06, 0.008, 1), T(-XF - 0.04, -0.06, 0));
  // Scanning / multibeam sonar on top of the forward foam
  add('metal', rbox(0.2, 0.02, 0.2, 0.006, R), T(0.8, FOAM_Y1 + 0.01, 0), 0x7d848b);
  add('paint', cyl(0.06, 0.065, 0.16, d.radial), T(0.8, FOAM_Y1 + 0.1, 0), 0x2b2f34);
  add('paint', cyl(0.067, 0.067, 0.02, d.radial), T(0.8, FOAM_Y1 + 0.04, 0), 0xd9a21b);
  add('glass', new THREE.SphereGeometry(0.06, d.radial, d.radial >> 2, 0, Math.PI * 2, 0, Math.PI / 2), T(0.8, FOAM_Y1 + 0.18, 0));
  // DVL (4 angled transducers) and altimeter below the tool skid plate
  add('paint', cyl(0.095, 0.095, 0.1, d.radial), T(0.75, -0.75, 0), 0x2d3238);
  add('paint', cyl(0.1, 0.1, 0.02, d.radial), T(0.75, -0.705, 0), 0xd9a21b);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const m = mul(T(0.75, -0.8, 0, 0, a, 0), T(0.05, 0, 0, 0, 0, 0.5));
    add('glass', cyl(0.032, 0.032, 0.012, d.small + 2), m);
  }
  add('paint', cyl(0.03, 0.03, 0.12, d.small), T(0.75, -0.75, 0.2), 0x9aa1a8);
  add('glass', new THREE.CircleGeometry(0.024, d.small), T(0.75, -0.811, 0.2, Math.PI / 2, 0, 0));
}

function buildTopside(add: Adder, d: Detail, root: THREE.Group): THREE.Object3D {
  const R = d.round;
  // Latch bullet / lift point
  add('metal', cyl(0.12, 0.13, 0.03, d.radial), T(0, FOAM_Y1 + 0.015, 0), 0x6d747b);
  const bullet: [number, number][] = [
    [0, 0], [0.075, 0], [0.075, 0.06], [0.045, 0.085], [0.045, 0.12], [0.072, 0.14], [0.072, 0.165], [0.03, 0.225], [0, 0.232],
  ];
  add('metal', lathe(bullet, d.radial), T(0, FOAM_Y1 + 0.03, 0), 0xc4c9ce);
  // Padeyes
  for (const s of [-1, 1]) {
    add('metal', rbox(0.16, 0.02, 0.1, 0.006, R), T(0, FOAM_Y1 + 0.01, s * 0.4), 0x6d747b);
    add('metal', new THREE.TorusGeometry(0.045, 0.013, d.small >> 1, d.small + 4), T(0, FOAM_Y1 + 0.07, s * 0.4), 0xc4c9ce);
  }
  // Umbilical termination + bend restrictor (tilted aft)
  const tx = -0.42;
  add('paint', cyl(0.085, 0.095, 0.08, d.radial), T(tx, FOAM_Y1 + 0.04, 0), 0x2b3036);
  add('metal', cyl(0.1, 0.1, 0.015, d.radial), T(tx, FOAM_Y1 + 0.085, 0), 0x8f969d);
  const tilt = 0.32;
  const base = mul(T(tx, FOAM_Y1 + 0.09, 0, 0, 0, tilt));
  const L = 0.3;
  const prof: [number, number][] = [[0, 0], [0.06, 0]];
  const ribs = 8;
  for (let k = 0; k < ribs; k++) {
    const y0 = (k / ribs) * L;
    const y1 = ((k + 0.7) / ribs) * L;
    const r = 0.058 - (0.028 * k) / ribs;
    prof.push([r, y0 + 0.004], [r, y1], [r - 0.008, y1 + 0.004], [r - 0.008, ((k + 1) / ribs) * L]);
  }
  prof.push([0, L]);
  add('rubber', lathe(prof, d.radial), base);
  add('rubber', cyl(0.022, 0.022, 0.12, d.small), mul(base, T(0, L + 0.06, 0)));
  const tether = new THREE.Object3D();
  tether.name = 'tether-point';
  tether.applyMatrix4(mul(base, T(0, L + 0.12, 0)));
  root.add(tether);
  return tether;
}
