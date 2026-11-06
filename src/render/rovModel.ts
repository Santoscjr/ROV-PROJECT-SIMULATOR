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
 * Surface detail (chipped paint, grime, brushed metal, foam pores) comes from
 * the shared procedural textures in rovTextures.ts.
 */
import * as THREE from 'three';
import { THRUSTERS } from '../physics/rovParams';
import {
  Adder,
  DUCT_RI,
  Detail,
  GeoSet,
  MAT_KEYS,
  MatKey,
  PILOT_DOME_R,
  PILOT_DOME_X,
  POD_END,
  AX,
  AY,
  AZ,
  T,
  TQ,
  V3,
  beam,
  boltRect,
  bolts,
  box,
  buildArm,
  clamps,
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
import { ATLAS_NAME, ATLAS_STRIPES, AtlasRect, Placard, atlasPlacard, createRovTextures } from './rovTextures';

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
const THRUSTER_LABELS: Placard[] = ['H1', 'H2', 'H3', 'H4', 'V1', 'V2', 'V3', 'V4'];
/**
 * Beam aim world.ts applies on top of each lamp mount (LAMPS[i].splay about the
 * mount Y, then .down about Z, deg). The lamp heads are drawn pointing where
 * the light actually goes; keep in sync with LAMPS in src/render/world.ts.
 */
export const LAMP_AIM: readonly (readonly [number, number])[] = [[9, 0], [-9, 0], [30, -10], [-30, -10]];
/** Auxiliary and tether camera viewpoints (body frame) and default view — mirrors src/render/cameras.ts. */
const AUX_CAM = { p: new THREE.Vector3(1.28, -0.42, 0.62), yaw: -8, pitch: -28 };
const TETHER_CAM = new THREE.Vector3(0.55, 1.02, 0.35);

export function createRovModel(opts: { quality?: Quality; envMap?: THREE.Texture | null } = {}): RovModel {
  const quality = opts.quality ?? 'high';
  const d = detailFor(quality);
  const tex = createRovTextures(quality);
  const { mats, dome: domeMat } = createMaterials(opts.envMap ?? null, tex);
  const sets = Object.fromEntries(MAT_KEYS.map((k) => [k, new GeoSet()])) as Record<MatKey, GeoSet>;
  const add: Adder = (k, g, m, c, w) => sets[k].add(g, m, c, w);

  const root = new THREE.Group();
  root.name = 'WC-150';

  buildFrame(add, d);
  buildFoam(add, d);
  const propellers = buildThrusters(add, d, root, mats.metal);
  buildSystems(add, d);
  buildHarness(add, d);
  const lightMounts = buildLights(add, d, root);
  buildSensors(add, d);
  buildAuxCameras(add, d);
  const tetherPoint = buildTopside(add, d, root);

  // Pilot camera pan/tilt
  const pan = new THREE.Vector3(1.16, -0.03, 0);
  add('paint', cyl(0.056, 0.056, 0.075, d.radial), T(pan.x, pan.y, 0), 0x2f3338, 0.3);
  add('paint', cyl(0.06, 0.06, 0.012, d.radial), T(pan.x, pan.y - 0.04, 0), 0x1b1d20);
  add('frame', rbox(0.08, 0.025, 0.21, 0.008, d.round), T(pan.x, pan.y - 0.055, 0));
  for (const s of [1, -1]) add('frame', rbox(0.06, 0.13, 0.016, 0.006, d.round), T(pan.x, pan.y - 0.12, s * 0.097));
  bolts(add, T(pan.x, pan.y - 0.0425, 0), [[0, -0.075], [0, 0.075]], d, 0.008);
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
    bolts(add, T(1.0, -0.605, s * 0.3), boltRect(0.12, 0.12, 2, 2), d);
    beam(add, 'frame', [1.0, -0.72, s * 0.3], [XF, -0.62, s * 0.3], 0.06, 0.06, d.round);
  }

  // Merge static buckets
  for (const k of MAT_KEYS) {
    if (sets[k].empty) continue;
    const mesh = new THREE.Mesh(sets[k].build(), mats[k]);
    mesh.name = `rov-static-${k}`;
    if (k === 'label') mesh.renderOrder = 1;
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
    mats.lens.emissiveIntensity = l * 9;
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
    tex.all.forEach((t) => t.dispose());
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

/** U-shaped grab handle: arc of radius r in the local XY plane bulging +Y, feet at ±r on X. */
function handle(add: Adder, m: THREE.Matrix4, r: number, d: Detail): void {
  add('metal', new THREE.TorusGeometry(r, 0.011, 6, Math.max(8, d.small + 4), Math.PI), m, 0xc9ced3, 0.3);
  for (const s of [1, -1]) {
    add('metal', rbox(0.045, 0.01, 0.04, 0.003, 1), mul(m, T(s * r, 0, 0)), 0x7c838a);
    bolts(add, mul(m, T(s * r, 0.005, 0, 0, 0, 0)), [[s * 0.012, 0]], d, 0.006);
  }
}

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
    // Bolts through the rubbing strip
    for (let k = -3; k <= 3; k++) bolts(add, T(k * 0.3, TOPY, s * (SZ + 0.06), s * Math.PI / 2), [[0, 0]], d, 0.009);
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
  bolts(add, T(-0.1, -0.6775, 0), boltRect(1.42, 0.92, 6, 4), d);
  for (const x of [-0.75, 0.55]) for (const z of [-0.45, 0.45]) beam(add, 'frame', [x, -0.7, z], [x, SKY, z], 0.04, 0.04, R);
  // Aft grab handles (bulging aft from the aft top cross member)
  for (const z of [-0.3, 0.3]) handle(add, T(-XF - 0.035, TOPY, z, Math.PI / 2, 0, Math.PI / 2), 0.07, d);
  // Anodes
  const anode = (x: number, y: number, z: number, ry = 0) => {
    add('metal', rbox(0.15, 0.045, 0.05, 0.01, R), T(x, y, z, 0, ry, 0), 0x9ea3a7, 0.6);
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

/** Foam wear: x = worn bevelled edges (top/bottom chamfers, well rims), y = side grime mask. */
function foamWear(g: THREE.BufferGeometry, k: number): void {
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const w = new Float32Array(nor.count * 2);
  for (let i = 0; i < nor.count; i++) {
    const ny = Math.abs(nor.getY(i));
    const bev = 4 * ny * (1 - ny);
    const t = Math.min(1, Math.max(0, (bev - 0.3) / 0.45));
    // lower edge sits on the frame and wears more than the upper one
    const low = pos.getY(i) < FOAM_Y0 + 0.08 ? 1.15 : 1;
    w[i * 2] = t * t * (3 - 2 * t) * low * k;
    w[i * 2 + 1] = (1 - ny) * (0.6 + 0.4 * Math.min(1, (FOAM_Y1 - pos.getY(i)) / 0.5));
  }
  g.setAttribute('wear', new THREE.Float32BufferAttribute(w, 2));
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
  foamWear(g, d.bevel > 1 ? 1 : 0.7);
  add('foam', g);
}

/** Decal quad (normal = local +Z of `m`) mapped to an atlas rectangle. */
function decal(add: Adder, w: number, h: number, m: THREE.Matrix4, r: AtlasRect): void {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[1] - r[0]), r[2] + uv.getY(i) * (r[3] - r[2]));
  add('label', g, m);
}

/** Decal lying on a horizontal surface at height y; text reads from the +Z side (or −Z if flip). */
function topDecal(add: Adder, w: number, h: number, x: number, y: number, z: number, r: AtlasRect, flip = false): void {
  decal(add, w, h, T(x, y + 0.003, z, -Math.PI / 2, 0, flip ? Math.PI : 0), r);
}

/** Retaining strap over a foam block at station x (stainless band with buckles). */
function foamStrap(add: Adder, d: Detail, x: number): void {
  const top = foamTop(x);
  const hw = FOAM_HW + 0.004;
  const col = 0x3b4046;
  add('metal', box(0.05, 0.005, 2 * (hw - 0.03)), T(x, top + 0.003, 0), col, 0.05);
  for (const s of [-1, 1]) {
    add('metal', box(0.05, top - 0.03 - (TOPY + 0.03), 0.005), T(x, (top - 0.03 + TOPY + 0.03) / 2, s * hw), col, 0.05);
    add('metal', box(0.05, 0.005, 0.045), T(x, top - 0.011, s * (hw - 0.013), s * Math.PI / 4), col, 0.05);
    add('metal', rbox(0.07, 0.055, 0.016, 0.004, 1), T(x, 0.13, s * (hw + 0.007)), 0xaeb4b9, 0.25);
    bolts(add, T(x, 0.13, s * (hw + 0.015), s * Math.PI / 2), [[-0.022, 0], [0.022, 0]], d, 0.007);
  }
}

function buildFoam(add: Adder, d: Detail): void {
  foamBlock(add, d, 0.31, XF + 0.04, [[0.7, 0.5], [0.7, -0.5]], 0.14, [0.04, 0]);
  foamBlock(add, d, -0.29, 0.29, [], 0.04, [0, 0]);
  foamBlock(add, d, -XF - 0.04, -0.31, [[-0.7, 0.5], [-0.7, -0.5]], 0.14, [0, 0.04]);
  foamStrap(add, d, 0.42);
  foamStrap(add, d, -0.38);
  // Thruster guard grilles across the vertical thruster wells: rim ring with
  // bolted tabs, flat bars across, two stiffeners underneath.
  for (const x of [0.7, -0.7]) {
    for (const zc of [0.5, -0.5]) {
      const gy = FOAM_Y1 - 0.012;
      add('frame', new THREE.TorusGeometry(0.2, 0.01, 6, Math.max(16, d.radial)), T(x, gy, zc, Math.PI / 2, 0, 0));
      for (let k = -4; k <= 4; k++) {
        const dz = k * 0.042;
        const half = Math.sqrt(0.2 * 0.2 - dz * dz);
        add('frame', box(half * 2, 0.016, 0.009), T(x, gy, zc + dz));
      }
      for (const dx of [-0.07, 0.07]) {
        const half = Math.sqrt(0.2 * 0.2 - dx * dx);
        add('frame', box(0.012, 0.03, half * 2), T(x + dx, gy - 0.018, zc));
      }
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const tx = x + Math.cos(a) * 0.222;
        const tz = zc + Math.sin(a) * 0.222;
        add('frame', rbox(0.05, 0.006, 0.035, 0.002, 1), T(tx, FOAM_Y1 + 0.002, tz, 0, -a, 0));
        bolts(add, T(tx, FOAM_Y1 + 0.005, tz), [[0, 0]], d, 0.006);
      }
    }
  }
  // Name decals on both sides of the forward block, hazard stripes elsewhere
  const zS = FOAM_HW + 0.002;
  decal(add, 0.58, 0.192, T(0.77, 0.4, zS), ATLAS_NAME);
  decal(add, 0.58, 0.192, T(0.77, 0.4, -zS, 0, Math.PI, 0), ATLAS_NAME);
  for (const s of [1, -1]) {
    decal(add, 0.5, 0.06, T(-0.74, FOAM_Y1 - 0.09, s * zS, 0, s > 0 ? 0 : Math.PI, 0), ATLAS_STRIPES);
    decal(add, 0.4, 0.06, T(-XF - 0.042, FOAM_Y1 - 0.2, s * 0.36, 0, -Math.PI / 2, 0), ATLAS_STRIPES);
    topDecal(add, 0.22, 0.11, 0, FOAM_Y1, s * 0.2, atlasPlacard('LIFT POINT'), s < 0);
  }
  decal(add, 1.0, 0.06, T(XF + 0.042, FOAM_Y1 - 0.25, 0, 0, Math.PI / 2, 0), ATLAS_STRIPES);
  decal(add, 0.3, 0.15, T(XF + 0.042, 0.28, 0, 0, Math.PI / 2, 0), atlasPlacard('WC-150'));
  decal(add, 0.2, 0.1, T(-XF - 0.042, 0.4, 0, 0, -Math.PI / 2, 0), atlasPlacard('CAUTION'));
  topDecal(add, 0.2, 0.1, 0.58, FOAM_Y1, 0, atlasPlacard('NO STEP'));
  topDecal(add, 0.2, 0.1, -0.83, FOAM_Y1, 0, atlasPlacard('NO STEP'));
  // Thruster IDs: H on the foam sides above each horizontal thruster, V beside each well
  THRUSTERS.forEach((t, i) => {
    const [x, , z] = t.position;
    const s = Math.sign(z);
    const r = atlasPlacard(THRUSTER_LABELS[i]);
    if (Math.abs(t.direction[1]) < 0.7) decal(add, 0.1, 0.05, T(x, 0.17, s * zS, 0, s > 0 ? 0 : Math.PI, 0), r);
    else topDecal(add, 0.1, 0.05, x, FOAM_Y1, z - s * 0.26, r, s < 0);
  });
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
    const vertical = Math.abs(dir.y) > 0.7;
    const m = TQ(pos, q);
    thrusterStatic(sub(add, m), podSign, d, !vertical);

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
    if (!vertical) {
      const top = lug(1);
      const bot = lug(-1);
      beam(add, 'frame', [top.x, top.y - 0.02, top.z], [top.x, TOPY, top.z], 0.05, 0.05, R);
      beam(add, 'frame', [bot.x, bot.y + 0.02, bot.z], [bot.x, SKY, bot.z], 0.05, 0.05, R);
    }
    // Power cable from the pod end to the junction box on that side
    const podEnd = pos.clone().addScaledVector(dir, podSign * (POD_END + 0.03));
    const out = podEnd.clone().addScaledVector(dir, podSign * 0.12);
    const side = Math.sign(pos.z);
    const jb = new THREE.Vector3(0.25 + (pos.x > 0 ? 0.06 : -0.06), -0.25, side * (0.36 + (vertical ? 0.03 : -0.03)));
    const mid = out.clone().lerp(jb, 0.5);
    mid.y = Math.min(mid.y, -0.15) - 0.05;
    const c = hose(add, 'rubber', [podEnd.toArray() as V3, out.toArray() as V3, mid.toArray() as V3, [jb.x, jb.y + 0.05, jb.z], jb.toArray() as V3], 0.011, d);
    clamps(add, c, 0.011, [0.12], d);
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
      add('metal', box(0.03, 0.006, 0.23), T(x, -0.02, s * 0.29), 0x3b4046);
    }
    for (const k of [0, 1, 2]) {
      add('metal', cyl(0.014, 0.014, 0.04, d.small), mul(T(c.x + 0.69, c.y + (k - 1) * 0.04, c.z), toX), 0xb7a06a);
    }
    // Junction boxes with bolted lids and HV placard
    add('paint', rbox(0.24, 0.13, 0.13, 0.02, R), T(0.25, -0.33, s * 0.36), 0x2b3036, 0.25);
    add('paint', rbox(0.25, 0.018, 0.14, 0.005, R), T(0.25, -0.257, s * 0.36), 0x4d555d);
    bolts(add, T(0.25, -0.248, s * 0.36), boltRect(0.22, 0.11, 4, 3), d, 0.007);
    for (const x of [0.19, 0.31]) add('metal', cyl(0.014, 0.014, 0.03, d.small), T(x, -0.235, s * 0.36), 0xb7a06a);
    decal(add, 0.15, 0.075, T(0.25, -0.335, s * 0.427, 0, s > 0 ? 0 : Math.PI, 0), atlasPlacard('DANGER HV'));
    // Compensators
    const cx = -0.72;
    const cz = s * 0.22;
    add('paint', cyl(0.075, 0.075, 0.26, d.radial), T(cx, -0.42, cz), 0xd8b024, 0.3);
    add('paint', cyl(0.08, 0.08, 0.025, d.radial), T(cx, -0.28, cz), 0x24272b);
    add('paint', cyl(0.08, 0.08, 0.025, d.radial), T(cx, -0.56, cz), 0x24272b);
    add('metal', cyl(0.012, 0.012, 0.05, d.small), T(cx, -0.25, cz), 0xd0d5da);
    hose(add, 'rubber', [[cx, -0.23, cz], [cx + 0.05, -0.18, cz], [-0.4, -0.3, s * 0.05], [-0.35, -0.42, 0]], 0.012, d);
    // Hydraulic hoses to the manipulator bases, clamped to the skid plate
    const h1 = hose(add, 'rubber', [[0.24, -0.47, s * 0.06], [0.42, -0.62, s * 0.12], [0.75, -0.66, s * 0.27], [0.93, -0.66, s * 0.27]], 0.014, d);
    hose(add, 'rubber', [[0.24, -0.5, s * 0.1], [0.45, -0.64, s * 0.17], [0.75, -0.7, s * 0.33], [0.93, -0.71, s * 0.33]], 0.012, d);
    clamps(add, h1, 0.014, [0.55, 0.85], d);
  }
  // Hydraulic power unit: electric motor + pump + manifold
  add('paint', lathe([[0, -0.38], [0.12, -0.38], [0.155, -0.36], [0.16, -0.32], [0.16, 0.12], [0.15, 0.14], [0, 0.14]], d.radial), mul(T(-0.17, -0.42, 0), toX), 0x3b5163, 0.3);
  for (let k = 0; k < 7; k++) add('paint', cyl(0.165, 0.165, 0.012, d.radial), mul(T(-0.17, -0.42, 0), toX, T(0, -0.3 + k * 0.055, 0)), 0x34495a, 0.3);
  add('paint', cyl(0.11, 0.12, 0.14, d.radial), mul(T(0.04, -0.42, 0), toX), 0x5b6670);
  add('paint', rbox(0.12, 0.2, 0.22, 0.015, R), T(0.17, -0.42, 0), 0x6f7a84);
  bolts(add, T(0.23, -0.42, 0, 0, 0, -Math.PI / 2), boltRect(0.17, 0.19, 2, 3), d, 0.008);
  for (const z of [-0.06, 0, 0.06]) add('metal', cyl(0.015, 0.015, 0.04, d.small), mul(T(0.24, -0.4, z), toX), 0xd0d5da);
  decal(add, 0.12, 0.06, T(0.232, -0.355, 0, 0, Math.PI / 2, 0), atlasPlacard('HYD 210 BAR'));
  add('frame', rbox(0.7, 0.03, 0.3, 0.008, R), T(-0.12, -0.6, 0));
  // Tool skid: valve packs + manifold
  add('paint', rbox(0.34, 0.1, 0.18, 0.015, R), T(-0.35, -0.625, 0.32), 0x2b3036, 0.25);
  add('paint', rbox(0.34, 0.1, 0.18, 0.015, R), T(-0.35, -0.625, -0.32), 0x2b3036, 0.25);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) add('metal', cyl(0.018, 0.018, 0.05, d.small), T(-0.47 + k * 0.08, -0.555, s * 0.32), 0xc0a45a);
  }
  add('paint', rbox(0.3, 0.09, 0.26, 0.015, R), T(-0.72, -0.63, 0), 0xc9661c, 0.35);
  bolts(add, T(-0.72, -0.585, 0), boltRect(0.26, 0.22, 3, 3), d, 0.008);
}

/** Signal / power harnesses routed under the top rails, clamped to the frame. */
function buildHarness(add: Adder, d: Detail): void {
  for (const s of [-1, 1]) {
    const z = s * 0.64;
    const toLight = hose(add, 'rubber', [
      [0.31, -0.24, s * 0.36], [0.31, -0.12, s * 0.5], [0.5, -0.055, z], [0.95, -0.055, z], [1.08, -0.2, s * 0.6], [1.12, -0.48, s * 0.56],
    ], 0.009, d, 0x262626);
    const toCam = hose(add, 'rubber', [
      [0.19, -0.24, s * 0.36], [0.22, -0.11, s * 0.52], [0.5, -0.035, z - s * 0.02], [0.95, -0.035, z - s * 0.02], [1.08, -0.05, s * 0.48], [1.11, -0.05, s * 0.44],
    ], 0.008, d, 0x262626);
    clamps(add, toLight, 0.009, [0.35, 0.5, 0.65], d);
    clamps(add, toCam, 0.008, [0.4, 0.6], d);
    // Bracket tabs on the top rail holding the clamps
    if (d.bolts) for (const x of [0.6, 0.85]) add('frame', box(0.02, 0.05, 0.06), T(x, -0.02, s * 0.67));
  }
  // Rear camera / aft harness on the port side
  const aft = hose(add, 'rubber', [
    [0.19, -0.24, -0.36], [0.1, -0.1, -0.55], [-0.4, -0.05, -0.64], [-0.95, -0.05, -0.64], [-1.1, -0.1, -0.25], [-1.12, -0.1, 0],
  ], 0.009, d, 0x262626);
  clamps(add, aft, 0.009, [0.3, 0.45, 0.6], d);
}

function buildLights(add: Adder, d: Detail, root: THREE.Group): THREE.Object3D[] {
  const mounts: THREE.Object3D[] = [];
  const specs: { p: V3; yaw: number; pitch: number; stem: V3 }[] = [
    { p: [1.06, 0.74, -0.5], yaw: 0.06, pitch: -0.14, stem: [1.01, foamTop(1.01) - 0.02, -0.5] },
    { p: [1.06, 0.74, 0.5], yaw: -0.06, pitch: -0.14, stem: [1.01, foamTop(1.01) - 0.02, 0.5] },
    { p: [1.27, -0.5, -0.56], yaw: 0.05, pitch: -0.2, stem: [XF, -0.56, -SZ + 0.03] },
    { p: [1.27, -0.5, 0.56], yaw: -0.05, pitch: -0.2, stem: [XF, -0.56, SZ - 0.03] },
  ];
  const names = ['upper-port', 'upper-stbd', 'lower-port', 'lower-stbd'];
  specs.forEach((s, i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw, s.pitch, 'YZX'));
    const mount = new THREE.Object3D();
    mount.name = `light-${names[i]}`;
    mount.position.set(...s.p);
    mount.quaternion.copy(q);
    mount.translateX(0.025);
    root.add(mount);
    mounts.push(mount);
    // Head drawn along the real beam: mount ⊗ splay ⊗ down, lens just behind the mount.
    const qh = q.clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(AY, (LAMP_AIM[i][0] * Math.PI) / 180))
      .multiply(new THREE.Quaternion().setFromAxisAngle(AZ, (LAMP_AIM[i][1] * Math.PI) / 180));
    const hp = mount.position.clone().addScaledVector(AX.clone().applyQuaternion(qh), -0.025);
    const m = TQ(hp, qh);
    lightHead(sub(add, m), d);
    // Stem from the frame to the clamp block under the trunnion yoke
    const clamp = new THREE.Vector3(-0.05, -0.05, 0).applyMatrix4(m);
    const stemTop: V3 = [clamp.x, clamp.y - 0.02, clamp.z];
    beam(add, 'frame', s.stem, stemTop, 0.04, 0.04, d.round);
    add('frame', rbox(0.06, 0.04, 0.05, 0.006, 1), T(stemTop[0], stemTop[1] + 0.005, stemTop[2]));
    if (i < 2) {
      add('frame', rbox(0.09, 0.012, 0.09, 0.004, 1), T(1.01, foamTop(1.01) - 0.012, s.p[2], 0, 0, -0.46));
      bolts(add, T(1.01, foamTop(1.01) - 0.006, s.p[2], 0, 0, -0.46), boltRect(0.06, 0.06, 2, 2), d, 0.006);
    }
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
  // Scanning / multibeam sonar on top of the forward foam, with a tubular guard
  const sx = 0.8;
  add('metal', rbox(0.2, 0.02, 0.2, 0.006, R), T(sx, FOAM_Y1 + 0.01, 0), 0x7d848b);
  bolts(add, T(sx, FOAM_Y1 + 0.02, 0), boltRect(0.16, 0.16, 2, 2), d, 0.008);
  add('paint', cyl(0.06, 0.065, 0.16, d.radial), T(sx, FOAM_Y1 + 0.1, 0), 0x2b2f34, 0.3);
  add('paint', cyl(0.067, 0.067, 0.02, d.radial), T(sx, FOAM_Y1 + 0.04, 0), 0xd9a21b);
  add('glass', new THREE.SphereGeometry(0.06, d.radial, d.radial >> 2, 0, Math.PI * 2, 0, Math.PI / 2), T(sx, FOAM_Y1 + 0.18, 0));
  for (const dx of [-0.08, 0.08]) {
    add('frame', new THREE.TorusGeometry(0.25, 0.011, 6, Math.max(12, d.radial >> 1), Math.PI), T(sx + dx, FOAM_Y1 + 0.005, 0, 0, Math.PI / 2, 0));
    for (const s of [-1, 1]) add('frame', rbox(0.05, 0.012, 0.05, 0.004, 1), T(sx + dx, FOAM_Y1 + 0.006, s * 0.25));
  }
  add('frame', box(0.17, 0.016, 0.022), T(sx, FOAM_Y1 + 0.255, 0));
  topDecal(add, 0.12, 0.06, sx, FOAM_Y1, 0.16, atlasPlacard('SONAR'));
  // DVL (4 angled transducers) and altimeter below the tool skid plate
  add('paint', cyl(0.095, 0.095, 0.1, d.radial), T(0.75, -0.75, 0), 0x2d3238, 0.3);
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
  add('metal', cyl(0.12, 0.13, 0.03, d.radial), T(0, FOAM_Y1 + 0.015, 0), 0x6d747b, 0.35);
  if (d.bolts) {
    const ring: [number, number][] = [];
    for (let k = 0; k < 8; k++) ring.push([Math.cos((k / 8) * Math.PI * 2) * 0.1, Math.sin((k / 8) * Math.PI * 2) * 0.1]);
    bolts(add, T(0, FOAM_Y1 + 0.03, 0), ring, d, 0.009);
  }
  const bullet: [number, number][] = [
    [0, 0], [0.075, 0], [0.075, 0.06], [0.045, 0.085], [0.045, 0.12], [0.072, 0.14], [0.072, 0.165], [0.03, 0.225], [0, 0.232],
  ];
  add('metal', lathe(bullet, d.radial), T(0, FOAM_Y1 + 0.03, 0), 0xc4c9ce, 0.4);
  // Padeyes with shackles, and top grab handles
  for (const s of [-1, 1]) {
    const z = s * 0.4;
    add('metal', rbox(0.16, 0.02, 0.1, 0.006, R), T(0, FOAM_Y1 + 0.01, z), 0x6d747b, 0.3);
    bolts(add, T(0, FOAM_Y1 + 0.02, z), boltRect(0.13, 0.07, 2, 2), d, 0.008);
    add('metal', rbox(0.1, 0.08, 0.025, 0.01, R), T(0, FOAM_Y1 + 0.06, z), 0x7c838a, 0.4);
    add('metal', cyl(0.009, 0.009, 0.075, d.small), T(0, FOAM_Y1 + 0.075, z, Math.PI / 2), 0xb9bec3);
    add('metal', new THREE.TorusGeometry(0.032, 0.008, 6, Math.max(8, d.small), Math.PI), T(0, FOAM_Y1 + 0.075, z, 0, Math.PI / 2, 0), 0xc9a54a, 0.3);
    handle(add, T(0, FOAM_Y1 + 0.004, s * 0.6), 0.075, d);
  }
  // Umbilical termination + bend restrictor. Vertical on x = −0.6: its axis
  // passes through the physics tether attachment (rovParams.tetherAttach,
  // −0.6, 1.05, 0) where world.ts ends the umbilical, and lines up with the
  // Top-Hat exit guide (TOPHAT.exit x = −0.6) when latched.
  const tx = -0.6;
  add('paint', cyl(0.085, 0.095, 0.08, d.radial), T(tx, FOAM_Y1 + 0.04, 0), 0x2b3036, 0.3);
  add('metal', cyl(0.1, 0.1, 0.015, d.radial), T(tx, FOAM_Y1 + 0.085, 0), 0x8f969d);
  if (d.bolts) {
    const ring: [number, number][] = [];
    for (let k = 0; k < 6; k++) ring.push([Math.cos((k / 6) * Math.PI * 2) * 0.085, Math.sin((k / 6) * Math.PI * 2) * 0.085]);
    bolts(add, T(tx, FOAM_Y1 + 0.0925, 0), ring, d, 0.007);
  }
  topDecal(add, 0.14, 0.07, tx, FOAM_Y1, 0.17, atlasPlacard('TETHER'));
  const base = T(tx, FOAM_Y1 + 0.09, 0);
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

/**
 * Physical housings of the auxiliary and tether cameras (their viewpoints are
 * defined in cameras.ts): lens a little behind the viewpoint, everything else
 * behind / below it, so neither view is obstructed.
 */
function buildAuxCameras(add: Adder, d: Detail): void {
  // Auxiliary camera: lower starboard bow, on a bracket from the front post.
  const yaw = THREE.MathUtils.degToRad(AUX_CAM.yaw);
  const pitch = THREE.MathUtils.degToRad(AUX_CAM.pitch);
  const dir = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
  const q = new THREE.Quaternion().setFromUnitVectors(AX, dir);
  const len = 0.12;
  const c = AUX_CAM.p.clone().addScaledVector(dir, -0.028 - len / 2);
  const cm = TQ(c, q);
  smallCamera(sub(add, cm), d, 0.03, len);
  add('metal', new THREE.TorusGeometry(0.033, 0.006, 5, d.small + 4), mul(cm, T(-0.02, 0, 0, 0, Math.PI / 2, 0)), 0x3b4046, 0.05);
  const back = c.clone().addScaledVector(dir, -0.02);
  beam(add, 'frame', [back.x, back.y - 0.035, back.z], [XF, back.y - 0.035, SZ - 0.03], 0.03, 0.03, d.round);
  add('frame', rbox(0.035, 0.03, 0.03, 0.004, 1), T(back.x, back.y - 0.028, back.z));
  const tail = c.clone().addScaledVector(dir, -len / 2 - 0.025);
  hose(add, 'rubber', [tail.toArray() as V3, [XF - 0.04, -0.33, SZ - 0.06], [XF - 0.06, -0.12, SZ - 0.1], [1.08, -0.05, 0.48]], 0.007, d, 0x262626);

  // Tether camera: compact pan/tilt ball on a short mast on the forward buoyancy,
  // just below the viewpoint (that view never looks more than ~50° down).
  const t = TETHER_CAM;
  const ball = new THREE.Vector3(t.x, t.y - 0.068, t.z);
  const foot: V3 = [t.x, FOAM_Y1, t.z - 0.08];
  add('metal', rbox(0.12, 0.012, 0.1, 0.004, 1), T(foot[0], FOAM_Y1 + 0.006, foot[2]), 0x7d848b, 0.3);
  bolts(add, T(foot[0], FOAM_Y1 + 0.012, foot[2]), boltRect(0.09, 0.07, 2, 2), d, 0.006);
  beam(add, 'frame', [foot[0], FOAM_Y1 + 0.01, foot[2]], [ball.x, ball.y - 0.06, ball.z], 0.035, 0.035, d.round);
  add('paint', cyl(0.032, 0.036, 0.035, d.radial), T(ball.x, ball.y - 0.045, ball.z), 0x2f3338, 0.3);
  add('paint', new THREE.SphereGeometry(0.032, d.radial, Math.max(6, d.radial >> 1)), T(ball.x, ball.y, ball.z), 0x6b7279, 0.2);
  // lens window facing the default view (aft and up)
  const vd = new THREE.Vector3(-Math.cos(0.38), Math.sin(0.38), 0);
  add('glass', new THREE.CircleGeometry(0.016, d.small + 2), TQ(ball.clone().addScaledVector(vd, 0.0325), new THREE.Quaternion().setFromUnitVectors(AZ, vd)));
  hose(add, 'rubber', [[ball.x, ball.y - 0.06, ball.z + 0.03], [ball.x + 0.02, FOAM_Y1 + 0.1, ball.z + 0.02], [ball.x + 0.04, FOAM_Y1 + 0.01, ball.z - 0.02]], 0.006, d, 0x262626);
}
