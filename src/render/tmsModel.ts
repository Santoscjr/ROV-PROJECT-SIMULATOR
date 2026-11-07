import * as THREE from 'three';
import { makeLabelTexture } from './materials';
import {
  type Adder,
  type Detail,
  GeoSet,
  MAT_KEYS,
  type MatKey,
  type V3,
  T,
  beam,
  bolts,
  boltRect,
  box,
  clamps,
  createMaterials,
  cyl,
  detailFor,
  hose,
  lathe,
  mul,
  rbox,
  rod,
  sub,
} from './rovModelParts';
import { ATLAS_STRIPES, type AtlasRect, atlasPlacard, createRovTextures } from './rovTextures';
import { TETHER_LOOK, tetherJacketMaterial } from './tetherLook';

/**
 * Procedural Top-Hat Tether Management System (training approximation): a
 * welded RHS frame that sits on top of the ROV, carrying a horizontal tether
 * drum (A-frame bearing supports, coaxial hydraulic drive), a level-wind under
 * the aft side of the drum, the tether exit guide (bellmouth + roller box)
 * above the ROV's tether termination, the latch receptacle for the ROV latch
 * bullet, a docking skirt that funnels the ROV top, the main umbilical
 * termination on top, an HPU / valve pack / electronics can, and a monitoring
 * camera with two lamps aimed at the drum, the level wind and the exit guide.
 *
 * Local frame = ROV body frame when latched (+X forward, +Y up); origin at
 * the TMS centre. Matches src/sim/topHat.ts (TOPHAT geometry): body half
 * extents 1.3 × 0.72 × 0.85, receptacle mouth (0, −0.66, 0), exit (−0.6,
 * −0.72, 0), lift point (0, 1.45, 0). The docked ROV (CG 1.43 m below) fits
 * inside the skirt without touching the TMS (tests/models.test.ts).
 *
 * Same procedural PBR pipeline as the ROV (rovModelParts / rovTextures):
 * static parts merged per material, vertex-coloured paint with edge wear.
 */

export interface TmsModel {
  root: THREE.Group;
  drum: THREE.Object3D;
  setDrumAngle(rad: number): void;
  setStoredFraction(f: number): void;
  setLevelWind(x: number): void;
  exitPoint: THREE.Object3D;
  liftPoint: THREE.Object3D;
  /** Camera pose: local −Z is the view direction (like a three.js camera). */
  cameraMount: THREE.Object3D;
  lightMounts: THREE.Object3D[];
  dispose(): void;
}

// --- Layout (m) ----------------------------------------------------------------
const HX = 1.3; // frame rail centre |x|
const HZ = 0.85; // frame rail centre |z|
const TOP_Y = 0.67; // top rail centre (0.62..0.72)
const BOT_Y = -0.65; // bottom rail centre (−0.70..−0.60)
const MID_Y = -0.35; // mid side rails
const RAIL = 0.1; // RHS size of the main rails
const DRUM_Y = 0.22;
const CORE_R = 0.17;
const FLANGE_R = 0.38;
const DRUM_HALF = 0.55; // flange centre |z|
const PACK_MAX = FLANGE_R * 0.84;
const SUPPORT_Z = 0.7; // A-frame bearing supports
const LW_X = -0.3;
const LW_Y = -0.42;
const LW_TRAVEL = 0.4; // ± carriage travel along Z
const FAIRLEAD_DX = -0.12; // fairlead (cable) position relative to the carriage
/** Level-wind guide rods and diamond screw (y relative to LW_Y): high on the carriage, clear of the camera's sight lines to the exit guide. */
const LW_RODS = [0.08, 0.14];
const LW_SCREW = 0.11;
const EXIT = new THREE.Vector3(-0.6, -0.72, 0);
const GUIDE_TOP = -0.55; // top of the exit-guide roller box
const LIFT_Y = 1.45;
const YELLOW = 0xd9a21b;
const ORANGE = 0xd2621e;
const DARK = 0x3a4047;

export function createTmsModel(opts: { quality?: 'low' | 'medium' | 'high' } = {}): TmsModel {
  const quality = opts.quality ?? 'high';
  const d = detailFor(quality);
  // The TMS is seen smaller / further than the ROV: one texture size down.
  const tex = createRovTextures(quality === 'high' ? 'medium' : 'low');
  const { mats, dome } = createMaterials(null, tex);
  dome.dispose();
  mats.lens.emissiveIntensity = 3.5; // TMS lamps are always powered
  const sets = Object.fromEntries(MAT_KEYS.map((k) => [k, new GeoSet()])) as Record<MatKey, GeoSet>;
  const add: Adder = (k, g, m, c, w) => sets[k].add(g, m, c, w);

  const root = new THREE.Group();
  root.name = 'tms';

  // Anchors first: some hardware is built in their frames.
  const exitPoint = new THREE.Object3D();
  exitPoint.name = 'tms-exit-point';
  exitPoint.position.copy(EXIT);
  const liftPoint = new THREE.Object3D();
  liftPoint.name = 'tms-lift-point';
  liftPoint.position.set(0, LIFT_Y, 0);
  const cameraMount = new THREE.Object3D();
  cameraMount.name = 'tms-camera';
  // High on the forward/+Z corner (inside the frame), looking diagonally
  // down/aft: frames the drum, the level wind under it and the exit guide.
  cameraMount.position.set(1.18, 0.52, 0.72);
  root.add(exitPoint, liftPoint, cameraMount);
  cameraMount.lookAt(new THREE.Vector3(-0.65, -0.55, -0.05));
  cameraMount.rotateY(Math.PI); // lookAt points +Z; cameras look along −Z
  const lightMounts: THREE.Object3D[] = [];
  // Two lamps on the forward lamp bar, beside (not in front of) the camera.
  for (const lp of [new THREE.Vector3(1.12, 0.66, 0.4), new THREE.Vector3(1.2, 0.66, -0.25)]) {
    const m = new THREE.Object3D();
    m.name = `tms-lamp-${lightMounts.length}`;
    m.position.copy(lp);
    root.add(m);
    m.lookAt(new THREE.Vector3(-0.5, -0.35, 0));
    m.rotateY(Math.PI);
    lightMounts.push(m);
  }
  root.updateMatrixWorld(true);

  buildFrame(add, d);
  buildSkirtAndLatch(add, d);
  buildTopside(add, d);
  buildDrumSupports(add, d);
  buildLevelWindRails(add, d);
  buildExitGuide(add, d);
  buildSystems(add, d);
  buildCamera(sub(add, cameraMount.matrix.clone()), d);
  lightMounts.forEach((m, i) => buildLamp(sub(add, m.matrix.clone()), d, i));
  buildHarness(add, d, cameraMount, lightMounts);

  for (const k of MAT_KEYS) {
    if (sets[k].empty) continue;
    const mesh = new THREE.Mesh(sets[k].build(), mats[k]);
    mesh.name = `tms-static-${k}`;
    if (k === 'label') mesh.renderOrder = 1;
    root.add(mesh);
  }

  // Name boards on both long sides (one draw call).
  const boardTex = makeLabelTexture('TMS-1', { w: 512, h: 160 });
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.62, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const boards = new GeoSet();
  for (const s of [1, -1]) boards.add(new THREE.PlaneGeometry(0.5, 0.156), T(0.6, 0.5, s * (HZ + 0.072), 0, s > 0 ? 0 : Math.PI, 0));
  const boardMesh = new THREE.Mesh(boards.build(), boardMat);
  boardMesh.name = 'tms-name-boards';
  root.add(boardMesh);

  // --- Drum (rotating about local Z): core, flanges, stored cable --------------
  const drum = new THREE.Group();
  drum.name = 'tms-drum';
  drum.position.set(0, DRUM_Y, 0);
  root.add(drum);
  const drumSet = new GeoSet();
  const drumMetal = new GeoSet();
  buildDrum((k, g, m, c, w) => (k === 'metal' ? drumMetal : drumSet).add(g, m, c, w), d);
  const flangeMesh = new THREE.Mesh(drumSet.build(), mats.paint);
  flangeMesh.name = 'tms-drum-flanges';
  const hubMesh = new THREE.Mesh(drumMetal.build(), mats.metal);
  hubMesh.name = 'tms-drum-hub';
  drum.add(flangeMesh, hubMesh);
  const cable = cableTextures(quality);
  const cableMat = new THREE.MeshStandardMaterial({
    name: 'tms-cable',
    map: cable.map,
    normalMap: cable.normal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: TETHER_LOOK.roughness,
    metalness: TETHER_LOOK.metalness,
  });
  const packGeo = new THREE.CylinderGeometry(1, 1, 2 * (DRUM_HALF - 0.015) - 0.006, d.radial * 2, 1, true);
  packGeo.rotateX(Math.PI / 2);
  const wrap = new THREE.Mesh(packGeo, cableMat);
  wrap.name = 'tms-cable-pack';
  drum.add(wrap);

  // --- Level-wind carriage (moves along Z) -------------------------------------
  const carriage = new THREE.Group();
  carriage.name = 'tms-level-wind';
  carriage.position.set(LW_X, LW_Y, 0);
  root.add(carriage);
  const cSets = { paint: new GeoSet(), metal: new GeoSet(), rubber: new GeoSet() };
  buildCarriage((k, g, m, c, w) => (k === 'rubber' ? cSets.rubber : k === 'metal' ? cSets.metal : cSets.paint).add(g, m, c, w), d);
  for (const [k, set] of Object.entries(cSets) as ['paint' | 'metal' | 'rubber', GeoSet][]) {
    const mesh = new THREE.Mesh(set.build(), mats[k]);
    mesh.name = `tms-level-wind-${k}`;
    carriage.add(mesh);
  }

  // --- Cable path: drum → level-wind fairlead → exit guide (two dynamic spans) ---
  // Mesmo cabo do tambor e do trecho livre: mesma capa e mesmo diâmetro (render/tetherLook.ts).
  const spanMat = tetherJacketMaterial('tms-cable-span');
  const spanGeo = new THREE.CylinderGeometry(TETHER_LOOK.radius, TETHER_LOOK.radius, 1, Math.max(6, d.small), 1, true);
  const spanA = new THREE.Mesh(spanGeo, spanMat);
  const spanB = new THREE.Mesh(spanGeo, spanMat);
  const spanC = new THREE.Mesh(spanGeo, spanMat);
  spanA.name = 'tms-cable-span-a';
  spanB.name = 'tms-cable-span-b';
  spanC.name = 'tms-cable-span-guide';
  root.add(spanA, spanB, spanC);
  const _d = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const placeSpan = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
    _d.subVectors(b, a);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(_up, _d.clone().normalize());
    m.scale.set(1, _d.length(), 1);
  };
  let radius = CORE_R + 0.05;
  let lw = 0;
  const tangent = new THREE.Vector3();
  const fairTop = new THREE.Vector3();
  const fairBot = new THREE.Vector3();
  const guideIn = new THREE.Vector3(EXIT.x, GUIDE_TOP - 0.01, 0);
  placeSpan(spanC, guideIn, EXIT);
  const updateSpans = () => {
    const z = lw * LW_TRAVEL;
    fairTop.set(LW_X + FAIRLEAD_DX, LW_Y + 0.13, z);
    fairBot.set(LW_X + FAIRLEAD_DX, LW_Y - 0.1, z);
    // Tangent from the fairlead to the cable pack (aft side of the drum).
    const rx = fairTop.x;
    const ry = fairTop.y - DRUM_Y;
    const dist = Math.hypot(rx, ry);
    const a = Math.atan2(ry, rx) - Math.acos(Math.min(1, radius / dist));
    tangent.set(Math.cos(a) * radius, DRUM_Y + Math.sin(a) * radius, z);
    placeSpan(spanA, tangent, fairTop);
    placeSpan(spanB, fairBot, guideIn);
  };

  const dispose = () => {
    const geos = new Set<THREE.BufferGeometry>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) geos.add(m.geometry);
    });
    geos.forEach((g) => g.dispose());
    for (const k of MAT_KEYS) mats[k].dispose();
    cableMat.dispose();
    spanMat.dispose();
    boardMat.dispose();
    boardTex.dispose();
    cable.map.dispose();
    cable.normal.dispose();
    tex.all.forEach((t) => t.dispose());
  };

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  boardMesh.castShadow = false;

  const model: TmsModel = {
    root,
    drum,
    setDrumAngle(rad) {
      drum.rotation.z = -rad;
    },
    setStoredFraction(f) {
      const c = Math.min(1, Math.max(0, f));
      radius = CORE_R + 0.004 + (PACK_MAX - CORE_R) * c;
      wrap.scale.set(radius, radius, 1);
      wrap.visible = f > 0.002;
      updateSpans();
    },
    setLevelWind(x) {
      lw = Math.min(1, Math.max(-1, x));
      carriage.position.z = lw * LW_TRAVEL;
      updateSpans();
    },
    exitPoint,
    liftPoint,
    cameraMount,
    lightMounts,
    dispose,
  };
  model.setStoredFraction(0.8);
  return model;
}

// ---------------------------------------------------------------------------
// Textures for the stored cable: wraps (helix) + metre marks, and wrap relief.
// ---------------------------------------------------------------------------

function cableTextures(q: 'low' | 'medium' | 'high'): { map: THREE.CanvasTexture; normal: THREE.DataTexture } {
  const W = q === 'low' ? 256 : 512;
  const H = 128; // 8 wraps per tile (v along the drum axis)
  const wraps = 8;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  // Base na cor da capa do tether; sulcos, reflexo e marcas por cima.
  ctx.fillStyle = TETHER_LOOK.colorCss;
  ctx.fillRect(0, 0, W, H);
  const pitch = H / wraps;
  // Helical wraps: each wrap advances one cable diameter per revolution.
  for (let k = -1; k <= wraps; k++) {
    ctx.strokeStyle = '#5e4712';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, k * pitch);
    ctx.lineTo(W, (k + 1) * pitch);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,240,205,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, k * pitch + pitch * 0.45);
    ctx.lineTo(W, (k + 1) * pitch + pitch * 0.45);
    ctx.stroke();
  }
  // Marcas de metragem (pretas, como as impressas na capa) e uma faixa vermelha
  // a cada volta, para a rotação do tambor aparecer na câmera.
  for (let i = 0; i < 4; i++) {
    const x = (i / 4) * W;
    ctx.fillStyle = i === 0 ? '#a8361c' : '#1c1d1f';
    for (let k = 0; k < wraps; k++) ctx.fillRect(x + (k * W) / wraps / 4, k * pitch + 3, i === 0 ? 10 : 4, pitch - 6);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, 4.5);
  map.anisotropy = 4;

  // Normal map: rounded wraps (half-cylinder profile across v).
  const n = new Uint8Array(4 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    const t = ((y / 64) * wraps) % 1; // position inside one wrap
    const slope = -Math.cos(t * Math.PI) * 0.9; // d(height)/dv of a rounded strand
    const len = Math.hypot(slope, 1);
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      n[i] = 128;
      n[i + 1] = Math.round((slope / len) * 127 + 128);
      n[i + 2] = Math.round((1 / len) * 127 + 128);
      n[i + 3] = 255;
    }
  }
  const normal = new THREE.DataTexture(n, 4, 64, THREE.RGBAFormat);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.magFilter = THREE.LinearFilter;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.generateMipmaps = true;
  normal.repeat.set(1, 4.5);
  normal.needsUpdate = true;
  return { map, normal };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** Rail of the main frame (yellow RHS). */
function rail(add: Adder, a: V3, b: V3, s: number, d: Detail): void {
  beam(add, 'paint', a, b, s, s, d.round, YELLOW);
}

/** Decal quad (normal = local +Z of `m`) mapped to an atlas rectangle. */
function decal(add: Adder, w: number, h: number, m: THREE.Matrix4, r: AtlasRect): void {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[1] - r[0]), r[2] + uv.getY(i) * (r[3] - r[2]));
  add('label', g, m);
}

function buildFrame(add: Adder, d: Detail): void {
  const R = RAIL;
  // Corner posts
  for (const x of [-HX, HX]) for (const z of [-HZ, HZ]) rail(add, [x, BOT_Y - R / 2, z], [x, TOP_Y + R / 2, z], 0.12, d);
  // Top / bottom / mid rails
  for (const y of [TOP_Y, BOT_Y]) {
    for (const z of [-HZ, HZ]) rail(add, [-HX, y, z], [HX, y, z], R, d);
    for (const x of [-HX, HX]) rail(add, [x, y, -HZ], [x, y, HZ], R, d);
  }
  for (const z of [-HZ, HZ]) rail(add, [-HX, MID_Y, z], [HX, MID_Y, z], 0.08, d);
  // Side diagonals (long sides) and end diagonals (kept away from the camera corner)
  for (const z of [-HZ, HZ]) {
    rail(add, [-HX + 0.05, BOT_Y + 0.05, z], [-0.35, TOP_Y - 0.05, z], 0.07, d);
    rail(add, [HX - 0.05, BOT_Y + 0.05, z], [0.35, TOP_Y - 0.05, z], 0.07, d);
  }
  for (const x of [-HX, HX]) rail(add, [x, BOT_Y + 0.05, HZ - 0.05], [x, TOP_Y - 0.05, -HZ + 0.05], 0.07, d);
  // Gusset plates at the post / rail joints
  if (d.bolts) {
    for (const x of [-HX, HX]) {
      for (const z of [-HZ, HZ]) {
        for (const y of [TOP_Y - 0.1, BOT_Y + 0.1]) {
          add('paint', box(0.012, 0.12, 0.12), T(x - Math.sign(x) * 0.066, y, z - Math.sign(z) * 0.1), YELLOW, 0.1);
          add('paint', box(0.12, 0.12, 0.012), T(x - Math.sign(x) * 0.1, y, z - Math.sign(z) * 0.066), YELLOW, 0.1);
        }
      }
    }
  }
  // Bottom cross members (along Z): receptacle bay (±0.3), aft guide support (−0.9)
  for (const x of [0.3, -0.3, -0.9]) rail(add, [x, BOT_Y, -HZ + 0.05], [x, BOT_Y, HZ - 0.05], 0.08, d);
  // Mid-level equipment cross members (forward systems, aft HPU)
  for (const x of [0.78, -0.85]) rail(add, [x, MID_Y, -HZ + 0.04], [x, MID_Y, HZ - 0.04], 0.08, d);
  // Anodes on the bottom side rails
  for (const s of [-1, 1]) {
    for (const x of [-0.75, 0.75]) {
      add('metal', rbox(0.22, 0.05, 0.06, 0.012, d.round), T(x, BOT_Y + 0.0, s * (HZ + 0.068)), 0x9ea3a7, 0.6);
      for (const dx of [-0.08, 0.08]) add('metal', box(0.025, 0.02, 0.03), T(x + dx, BOT_Y, s * (HZ + 0.05)), 0x6d7378);
    }
  }
  // Name-board backing plates (decal mesh in front)
  for (const s of [1, -1]) {
    add('paint', rbox(0.54, 0.19, 0.012, 0.004, 1), T(0.6, 0.5, s * (HZ + 0.064)), YELLOW, 0.1);
    add('paint', box(0.04, 0.16, 0.012), T(0.36, 0.6, s * (HZ + 0.056)), YELLOW);
    add('paint', box(0.04, 0.16, 0.012), T(0.84, 0.6, s * (HZ + 0.056)), YELLOW);
    if (d.bolts) bolts(add, T(0.6, 0.52, s * (HZ + 0.07), s * Math.PI / 2), [[-0.24, -0.08], [0.24, -0.08], [-0.24, 0.08], [0.24, 0.08]], d, 0.007);
  }
}

function buildSkirtAndLatch(add: Adder, d: Detail): void {
  // Docking skirt: sloped guide plates under the bottom rails, flaring outward
  // (funnel), clear of the ROV buoyancy (|z| ≤ 0.725, |x| ≤ 1.22).
  const topY = BOT_Y - 0.05;
  const botY = -0.9;
  const h = topY - botY;
  for (const s of [-1, 1]) {
    // long sides
    const z0 = s * (HZ + 0.0);
    const z1 = s * (HZ + 0.085);
    const ang = Math.atan2(z1 - z0, h);
    add('paint', rbox(2 * HX - 0.24, Math.hypot(h, z1 - z0), 0.016, 0.004, 1), T(0, (topY + botY) / 2, (z0 + z1) / 2, -ang, 0, 0), YELLOW, 0.1);
    // ends
    const x0 = s * (HX - 0.02);
    const x1 = s * (HX + 0.06);
    const angX = Math.atan2(x1 - x0, h);
    add('paint', rbox(0.016, Math.hypot(h, x1 - x0), 2 * HZ - 0.3, 0.004, 1), T((x0 + x1) / 2, (topY + botY) / 2, 0, 0, 0, angX), YELLOW, 0.1);
    // HDPE rubbing strip along the lower edge of the side plates
    add('rubber', rbox(2 * HX - 0.3, 0.035, 0.03, 0.008, 1), T(0, botY + 0.02, (z1 - s * 0.006) * 1.0));
  }
  // Corner gussets between side and end plates
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = new THREE.Vector3(sx * (HX - 0.09), (topY + botY) / 2, sz * (HZ + 0.04));
      const b = new THREE.Vector3(sx * (HX + 0.02), (topY + botY) / 2, sz * (HZ - 0.12));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      add('paint', box(0.012, h * 0.95, a.distanceTo(b)), T(mid.x, mid.y, mid.z, 0, yaw, 0), YELLOW, 0.1);
    }
  }

  // Receptacle bay: two longitudinal beams + mounting plate with the latch funnel
  for (const z of [-0.3, 0.3]) rail(add, [-0.3, BOT_Y, z], [0.3, BOT_Y, z], 0.08, d);
  const plate = new THREE.Shape();
  plate.moveTo(-0.27, -0.27);
  plate.lineTo(0.27, -0.27);
  plate.lineTo(0.27, 0.27);
  plate.lineTo(-0.27, 0.27);
  plate.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.255, 0, Math.PI * 2, true);
  plate.holes.push(hole);
  const pg = new THREE.ExtrudeGeometry(plate, { depth: 0.02, bevelEnabled: false, curveSegments: Math.max(8, d.radial >> 1) });
  pg.rotateX(Math.PI / 2);
  add('paint', pg, T(0, BOT_Y + 0.04, 0), YELLOW, 0.1);
  // Latch funnel (closed wall): mouth at TOPHAT.receptacle (y −0.66) r 0.25 → throat r 0.09 at −0.5
  const yM = -0.66;
  const yT = -0.5;
  const funnel: [number, number][] = [
    [0.09, yT + 0.002],
    [0.12, yT - 0.03],
    [0.25, yM + 0.012],
    [0.262, yM],
    [0.275, yM + 0.012],
    [0.272, yM + 0.03],
    [0.134, yT - 0.02],
    [0.104, yT + 0.012],
    [0.09, yT + 0.012],
  ];
  // Profile goes inside→outside, so flip it to get outward normals.
  add('metal', lathe(funnel, d.radial), undefined, 0xb4b9be, 0.35);
  // Latch body above the throat: bore continues to a cap at −0.40
  add('paint', lathe([[0.09, -0.5], [0.14, -0.5], [0.15, -0.49], [0.15, -0.41], [0.14, -0.4], [0.09, -0.4]], d.radial), undefined, DARK, 0.25);
  add('paint', lathe([[0, -0.4], [0.092, -0.4]], d.radial), undefined, 0x222528, 0);
  add('metal', lathe([[0.091, -0.4], [0.091, -0.5]], d.radial), undefined, 0x8f969d, 0.2);
  add('paint', cyl(0.155, 0.155, 0.02, d.radial), T(0, -0.395, 0), DARK, 0.2);
  if (d.bolts) {
    const ring: [number, number][] = [];
    for (let k = 0; k < 8; k++) ring.push([Math.cos((k / 8) * Math.PI * 2) * 0.125, Math.sin((k / 8) * Math.PI * 2) * 0.125]);
    bolts(add, T(0, -0.385, 0), ring, d, 0.008);
  }
  // Latch actuators (hydraulic cylinders driving the dogs), along X on both sides
  for (const s of [-1, 1]) {
    const z = s * 0.19;
    add('paint', cyl(0.034, 0.034, 0.22, d.small + 2), T(0.2, -0.45, z, 0, 0, Math.PI / 2), 0x2b2f34, 0.25);
    add('metal', cyl(0.014, 0.014, 0.12, d.small), T(0.04, -0.45, z, 0, 0, Math.PI / 2), 0xdfe4e8, 0.1);
    add('paint', rbox(0.05, 0.05, 0.06, 0.008, 1), T(-0.01, -0.45, s * 0.165), DARK);
    add('paint', rbox(0.04, 0.09, 0.06, 0.008, 1), T(0.32, -0.45, z), DARK);
    // bracket down to the bay beam
    add('paint', box(0.04, 0.17, 0.02), T(0.32, -0.54, z), YELLOW);
    if (d.bolts) for (const x of [0.12, 0.27]) add('metal', cyl(0.037, 0.037, 0.008, d.small), T(x, -0.45, z, 0, 0, Math.PI / 2), 0xb9bec3);
  }
}

function buildTopside(add: Adder, d: Detail): void {
  // Deck beams (along Z at x ±0.45, ±0.95 fwd/aft) and longitudinals at z ±0.7
  for (const x of [-0.95, -0.45, 0.45]) rail(add, [x, TOP_Y, -HZ + 0.05], [x, TOP_Y, HZ - 0.05], 0.08, d);
  // shallow forward deck bearer (keeps the lamp beams clear)
  beam(add, 'paint', [0.9, 0.695, -HZ + 0.05], [0.9, 0.695, HZ - 0.05], 0.08, 0.05, d.round, YELLOW);
  for (const z of [-SUPPORT_Z, SUPPORT_Z]) rail(add, [-HX + 0.05, TOP_Y, z], [HX - 0.05, TOP_Y, z], 0.08, d);
  // Lamp bar (forward), carries both TMS lamps
  rail(add, [1.2, 0.715, -HZ + 0.05], [1.2, 0.715, HZ - 0.05], 0.04, d);
  // Termination spider plate (centre)
  add('paint', rbox(0.84, 0.03, 0.5, 0.008, d.round), T(0, 0.715, 0), YELLOW, 0.1);
  for (const z of [-0.25, 0.25]) rail(add, [-0.42, TOP_Y, z], [0.42, TOP_Y, z], 0.07, d);
  // Grating over the fore/aft bays: bearing bars + cross bars
  const grating = (x0: number, x1: number) => {
    const n = Math.round((x1 - x0) / 0.05);
    for (let i = 0; i <= n; i++) add('frame', box(0.006, 0.03, 2 * (SUPPORT_Z - 0.04)), T(x0 + ((x1 - x0) * i) / n, 0.705, 0), 0xffffff);
    for (let z = -SUPPORT_Z + 0.06; z <= SUPPORT_Z - 0.05; z += 0.1) add('frame', box(x1 - x0, 0.008, 0.008), T((x0 + x1) / 2, 0.716, z));
  };
  grating(-1.24, -1.0);
  grating(-0.9, -0.5);
  grating(0.5, 0.86);
  // Main umbilical termination: housing + ribbed bend restrictor (lift point inside, y 1.45)
  const housing: [number, number][] = [[0, 0.73], [0.16, 0.73], [0.16, 0.76], [0.12, 0.77], [0.12, 0.9], [0.135, 0.905], [0.135, 0.93], [0.09, 0.95], [0, 0.95]];
  add('paint', lathe(housing, d.radial), undefined, DARK, 0.3);
  if (d.bolts) {
    const ring: [number, number][] = [];
    for (let k = 0; k < 10; k++) ring.push([Math.cos((k / 10) * Math.PI * 2) * 0.14, Math.sin((k / 10) * Math.PI * 2) * 0.14]);
    bolts(add, T(0, 0.76, 0), ring, d, 0.009);
  }
  const L = 0.56;
  const prof: [number, number][] = [[0, 0.95], [0.085, 0.95]];
  const ribs = 10;
  for (let k = 0; k < ribs; k++) {
    const y0 = 0.95 + (k / ribs) * L;
    const y1 = 0.95 + ((k + 0.7) / ribs) * L;
    const r = 0.085 - (0.045 * k) / ribs;
    prof.push([r, y0 + 0.004], [r, y1], [r - 0.01, y1 + 0.005], [r - 0.01, 0.95 + ((k + 1) / ribs) * L]);
  }
  prof.push([0, 0.95 + L]);
  add('rubber', lathe(prof, d.radial), undefined);
  add('rubber', cyl(0.028, 0.028, 0.08, d.small), T(0, 0.95 + L + 0.04, 0));
  // Deck-handling padeyes with shackles at the corners
  for (const x of [-0.95, 0.95]) {
    for (const z of [-0.6, 0.6]) {
      add('metal', rbox(0.12, 0.012, 0.08, 0.004, 1), T(x, 0.716, z), 0x7c838a, 0.3);
      add('metal', rbox(0.08, 0.07, 0.022, 0.008, 1), T(x, 0.755, z), 0x7c838a, 0.4);
      add('metal', new THREE.TorusGeometry(0.028, 0.007, 6, Math.max(8, d.small), Math.PI), T(x, 0.77, z, 0, Math.PI / 2, 0), 0xc9a54a, 0.3);
    }
  }
  decal(add, 0.18, 0.08, T(0, 0.733, 0.205, -Math.PI / 2, 0, 0), atlasPlacard('LIFT POINT'));
  decal(add, 0.18, 0.08, T(0, 0.733, -0.205, -Math.PI / 2, 0, Math.PI), atlasPlacard('LIFT POINT'));
  // Hazard stripes along the top rails
  for (const s of [-1, 1]) decal(add, 1.0, 0.05, T(-0.6, TOP_Y, s * (HZ + 0.051), 0, s > 0 ? 0 : Math.PI, 0), ATLAS_STRIPES);
}

function buildDrum(add: Adder, d: Detail): void {
  // Core (closed), flanges with stiffener ribs and rim lip, hubs and axle.
  add('paint', cyl(CORE_R, CORE_R, 2 * DRUM_HALF, d.radial), T(0, 0, 0, Math.PI / 2), 0x2f3439, 0.2);
  for (const s of [-1, 1]) {
    const z = s * DRUM_HALF;
    add('paint', cyl(FLANGE_R, FLANGE_R, 0.03, d.radial * 2), T(0, 0, z, Math.PI / 2), ORANGE, 0.3);
    add('paint', new THREE.TorusGeometry(FLANGE_R, 0.012, 6, d.radial * 2), T(0, 0, z), ORANGE, 0.6);
    const ribs = 8;
    for (let k = 0; k < ribs; k++) {
      const a = (k / ribs) * Math.PI * 2;
      const r = (FLANGE_R + 0.1) / 2;
      add('paint', rbox(FLANGE_R - 0.12, 0.022, 0.04, 0.005, 1), T(Math.cos(a) * r, Math.sin(a) * r, z + s * 0.035, 0, 0, a), ORANGE, 0.3);
    }
    // lightening holes (dark discs) between ribs
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * Math.PI * 2;
      add('paint', cyl(0.045, 0.045, 0.002, d.small + 2), T(Math.cos(a) * 0.27, Math.sin(a) * 0.27, z + s * 0.016, Math.PI / 2), 0x15171a, 0);
    }
    add('metal', cyl(0.1, 0.1, 0.03, d.radial), T(0, 0, z + s * 0.03, Math.PI / 2), 0x8f969d, 0.3);
    if (d.bolts) {
      const ring: [number, number][] = [];
      for (let k = 0; k < 6; k++) ring.push([Math.cos((k / 6) * Math.PI * 2) * 0.075, Math.sin((k / 6) * Math.PI * 2) * 0.075]);
      bolts(add, T(0, 0, z + s * 0.045, s * Math.PI / 2), ring, d, 0.008);
    }
  }
  add('metal', cyl(0.05, 0.05, 2 * SUPPORT_Z + 0.06, d.small + 4), T(0, 0, 0, Math.PI / 2), 0xb9bec3, 0.2);
}

function buildDrumSupports(add: Adder, d: Detail): void {
  for (const s of [-1, 1]) {
    const z = s * SUPPORT_Z;
    // A-frame legs from the bottom cross members to the bearing, post up to the deck
    rail(add, [0.3, BOT_Y + 0.04, z], [0.02, DRUM_Y + 0.02, z], 0.07, d);
    rail(add, [-0.3, BOT_Y + 0.04, z], [-0.02, DRUM_Y + 0.02, z], 0.07, d);
    rail(add, [0, DRUM_Y + 0.08, z], [0, TOP_Y - 0.04, z], 0.07, d);
    rail(add, [-0.24, -0.38, z], [0.24, -0.38, z], 0.05, d);
    // Pillow-block bearing
    add('paint', rbox(0.2, 0.05, 0.08, 0.01, d.round), T(0, DRUM_Y - 0.075, s * 0.64), DARK, 0.3);
    add('paint', cyl(0.085, 0.085, 0.08, d.radial), T(0, DRUM_Y, s * 0.64, Math.PI / 2), DARK, 0.3);
    add('metal', cyl(0.012, 0.012, 0.02, 6), T(0, DRUM_Y + 0.09, s * 0.64), 0xb7a06a);
    bolts(add, T(0, DRUM_Y - 0.05, s * 0.64), [[-0.08, 0], [0.08, 0]], d, 0.009);
    // Saddle plate tying the bearing block to the A-frame apex
    add('paint', box(0.24, 0.16, 0.014), T(0, DRUM_Y - 0.02, z - s * 0.042), YELLOW, 0.1);
  }
  // Coaxial hydraulic drive on the −Z end: planetary gearbox + motor + hoses
  const toZ = Math.PI / 2;
  add('paint', lathe([[0, -0.02], [0.12, -0.02], [0.13, -0.01], [0.13, 0.05], [0.1, 0.06], [0, 0.06]], d.radial), mul(T(0, DRUM_Y, -SUPPORT_Z - 0.03, -toZ)), DARK, 0.3);
  add('paint', cyl(0.075, 0.075, 0.1, d.radial), T(0, DRUM_Y, -SUPPORT_Z - 0.14, toZ), 0x3b5163, 0.3);
  for (let k = 0; k < 4; k++) add('paint', cyl(0.08, 0.08, 0.008, d.radial), T(0, DRUM_Y, -SUPPORT_Z - 0.105 - k * 0.022, toZ), 0x34495a, 0.3);
  add('metal', cyl(0.06, 0.06, 0.02, d.radial), T(0, DRUM_Y, -SUPPORT_Z - 0.2, toZ), 0x8f969d);
  if (d.bolts) {
    const ring: [number, number][] = [];
    for (let k = 0; k < 8; k++) ring.push([Math.cos((k / 8) * Math.PI * 2) * 0.11, Math.sin((k / 8) * Math.PI * 2) * 0.11]);
    bolts(add, T(0, DRUM_Y, -SUPPORT_Z - 0.09, -toZ), ring, d, 0.008);
  }
  for (const dy of [-0.035, 0.035]) {
    add('metal', cyl(0.014, 0.014, 0.05, d.small), T(0.06, DRUM_Y + dy, -SUPPORT_Z - 0.15, 0, 0, Math.PI / 2), 0xd0d5da);
    const h = hose(add, 'rubber', [[0.09, DRUM_Y + dy, -SUPPORT_Z - 0.15], [0.25, DRUM_Y + dy - 0.05, -SUPPORT_Z - 0.13], [0.5, -0.05, -0.78], [0.7 + dy, MID_Y + 0.215, -0.6]], 0.014, d);
    clamps(add, h, 0.014, [0.5], d);
  }
}

function buildLevelWindRails(add: Adder, d: Detail): void {
  const zEnd = SUPPORT_Z - 0.02;
  // Guide rods above / below the diamond screw, between brackets on the A-frames
  for (const dy of LW_RODS) rod(add, 'metal', [LW_X, LW_Y + dy, -zEnd], [LW_X, LW_Y + dy, zEnd], 0.012, d.small + 2, 0xc9ced3);
  rod(add, 'metal', [LW_X, LW_Y + LW_SCREW, -zEnd], [LW_X, LW_Y + LW_SCREW, zEnd], 0.018, d.small + 2, 0xa9afb4);
  // Diamond thread hint: helical ridges as thin rings
  if (d.bolts) for (let z = -zEnd + 0.04; z < zEnd - 0.03; z += 0.04) add('metal', new THREE.TorusGeometry(0.018, 0.003, 4, d.small), T(LW_X, LW_Y + LW_SCREW, z, 0, 0.35, 0), 0x8f969d);
  for (const s of [-1, 1]) {
    add('paint', rbox(0.14, 0.12, 0.016, 0.006, 1), T(LW_X + 0.04, LW_Y + LW_SCREW, s * (zEnd + 0.008)), YELLOW, 0.1);
    add('paint', box(0.1, 0.035, 0.03), T(LW_X + 0.12, LW_Y + LW_SCREW, s * (zEnd + 0.004)), YELLOW);
  }
  // Level-wind drive: small hydraulic motor + gearbox on the −Z end of the screw
  add('paint', rbox(0.09, 0.09, 0.05, 0.01, d.round), T(LW_X, LW_Y + LW_SCREW, -zEnd + 0.04), DARK, 0.3);
  add('paint', cyl(0.03, 0.03, 0.08, d.small + 2), T(LW_X + 0.07, LW_Y + LW_SCREW, -zEnd + 0.04, 0, 0, Math.PI / 2), 0x3b5163, 0.3);
}

function buildCarriage(add: Adder, d: Detail): void {
  // Body around the screw, bushings on the rods, fairlead (rollers) on the aft side.
  add('paint', rbox(0.16, 0.3, 0.13, 0.015, d.round), T(0, 0.03, 0), YELLOW, 0.1);
  for (const dy of LW_RODS) add('metal', cyl(0.022, 0.022, 0.15, d.small + 2), T(0, dy, 0, Math.PI / 2), 0x8f969d, 0.2);
  add('metal', cyl(0.03, 0.03, 0.15, d.small + 2), T(0, LW_SCREW, 0, Math.PI / 2), 0xb7a06a, 0.2);
  const fx = FAIRLEAD_DX;
  for (const dy of [0.12, -0.12]) add('paint', rbox(0.11, 0.014, 0.12, 0.004, 1), T(fx + 0.025, dy, 0), YELLOW, 0.1);
  for (const s of [-1, 1]) add('rubber', cyl(0.02, 0.02, 0.22, d.small + 2), T(fx, 0, s * 0.037));
  for (const dy of [0.1, -0.1]) add('rubber', cyl(0.018, 0.018, 0.1, d.small + 2), T(fx - 0.035, dy, 0, Math.PI / 2));
  for (const dy of [0.1, -0.1]) add('rubber', cyl(0.018, 0.018, 0.1, d.small + 2), T(fx + 0.035, dy, 0, Math.PI / 2));
  // the cable running through the fairlead
  add('rubber', cyl(0.016, 0.016, 0.23, Math.max(6, d.small)), T(fx, 0.015, 0));
  if (d.bolts) bolts(add, T(0.08, 0, 0, 0, 0, -Math.PI / 2), [[-0.08, -0.04], [0.08, -0.04], [-0.08, 0.04], [0.08, 0.04]], d, 0.007);
}

function buildExitGuide(add: Adder, d: Detail): void {
  const x = EXIT.x;
  // Bellmouth (closed wall): lip at y −0.70 (r 0.22), throat r 0.1 at −0.62
  const bell: [number, number][] = [
    [0.12, -0.6],
    [0.124, -0.62],
    [0.15, -0.655],
    [0.205, -0.688],
    [0.225, -0.697],
    [0.238, -0.69],
    [0.235, -0.676],
    [0.17, -0.64],
    [0.138, -0.612],
    [0.136, -0.6],
  ];
  add('metal', lathe(bell, d.radial), T(x, 0, 0), 0xb4b9be, 0.4);
  // Roller box: 4 polyurethane rollers around a 0.2 m aperture, box plates
  const yR = GUIDE_TOP - 0.03;
  for (const s of [-1, 1]) {
    add('rubber', cyl(0.022, 0.022, 0.2, d.small + 2), T(x, yR, s * 0.124, 0, 0, Math.PI / 2));
    add('rubber', cyl(0.022, 0.022, 0.2, d.small + 2), T(x + s * 0.124, yR, 0, Math.PI / 2));
    add('paint', box(0.31, 0.06, 0.01), T(x, yR, s * 0.155), YELLOW, 0.1);
    add('paint', box(0.01, 0.06, 0.31), T(x + s * 0.155, yR, 0), YELLOW, 0.1);
    // support straps to the bottom cross members (x −0.3 / −0.9)
    const xe = s > 0 ? -0.33 : -0.87;
    beam(add, 'paint', [x + s * 0.155, yR, 0], [xe, BOT_Y + 0.03, 0], 0.05, 0.012, 1, YELLOW);
    beam(add, 'paint', [x + s * 0.155, yR, 0.11], [xe, BOT_Y + 0.03, 0.11], 0.04, 0.012, 1, YELLOW);
    beam(add, 'paint', [x + s * 0.155, yR, -0.11], [xe, BOT_Y + 0.03, -0.11], 0.04, 0.012, 1, YELLOW);
    add('metal', cyl(0.008, 0.008, 0.32, 6), T(x, yR, s * 0.124, 0, 0, Math.PI / 2), 0xc7ccd1);
    add('metal', cyl(0.008, 0.008, 0.32, 6), T(x + s * 0.124, yR, 0, Math.PI / 2), 0xc7ccd1);
  }
  decal(add, 0.12, 0.06, T(x, yR, 0.161), atlasPlacard('TETHER'));
}

function buildSystems(add: Adder, d: Detail): void {
  const R = d.round;
  const toZ = T(0, 0, 0, Math.PI / 2);
  // Electronics / telemetry can (titanium), along Z on saddles over the forward cross member
  const cx = 0.78;
  const cy = MID_Y + 0.04 + 0.1;
  const prof: [number, number][] = [[0, -0.42], [0.06, -0.42], [0.09, -0.4], [0.1, -0.37], [0.1, 0.33], [0.112, 0.335], [0.112, 0.38], [0.095, 0.39], [0.07, 0.41], [0, 0.42]];
  add('metal', lathe(prof, d.radial), mul(T(cx, cy, 0), toZ), 0x8f969d, 0.25);
  for (const z of [-0.25, 0.25]) {
    add('paint', rbox(0.2, 0.05, 0.05, 0.008, 1), T(cx, MID_Y + 0.055, z), YELLOW, 0.1);
    add('metal', new THREE.TorusGeometry(0.104, 0.006, 5, d.radial, Math.PI), T(cx, cy, z), 0x3b4046, 0.05);
  }
  for (let k = 0; k < 3; k++) add('metal', cyl(0.014, 0.014, 0.04, d.small), mul(T(cx + (k - 1) * 0.04, cy, 0.44), toZ), 0xb7a06a);
  // Junction box (+Z) and hydraulic valve pack (−Z) on the same cross member
  add('paint', rbox(0.28, 0.17, 0.22, 0.02, R), T(cx, MID_Y + 0.125, 0.6), 0x2b3036, 0.25);
  add('paint', rbox(0.29, 0.018, 0.23, 0.005, R), T(cx, MID_Y + 0.219, 0.6), 0x4d555d);
  bolts(add, T(cx, MID_Y + 0.228, 0.6), boltRect(0.26, 0.2, 4, 3), d, 0.007);
  decal(add, 0.15, 0.075, T(cx + 0.141, MID_Y + 0.12, 0.6, 0, Math.PI / 2, 0), atlasPlacard('DANGER HV'));
  add('paint', rbox(0.3, 0.16, 0.22, 0.015, R), T(cx, MID_Y + 0.12, -0.6), ORANGE, 0.35);
  for (let k = 0; k < 4; k++) add('metal', cyl(0.018, 0.018, 0.05, d.small), T(cx - 0.11 + k * 0.073, MID_Y + 0.225, -0.6), 0xc0a45a);
  bolts(add, T(cx, MID_Y + 0.2, -0.6), boltRect(0.26, 0.18, 3, 3), d, 0.008);
  decal(add, 0.12, 0.06, T(cx + 0.151, MID_Y + 0.12, -0.6, 0, Math.PI / 2, 0), atlasPlacard('HYD 210 BAR'));
  // Harness: can → junction box
  for (const k of [0, 1]) hose(add, 'rubber', [[cx + (k - 0.5) * 0.04, cy, 0.46], [cx + (k - 0.5) * 0.04, cy - 0.01, 0.48], [cx + (k - 0.5) * 0.06, MID_Y + 0.1, 0.49]], 0.009, d, 0x262626);

  // HPU (aft bay): electric motor + pump along Z on the aft mid cross member, compensator
  const hx = -0.85;
  const hy = MID_Y + 0.04 + 0.15;
  const toMZ = T(0, 0, 0, -Math.PI / 2);
  add('paint', lathe([[0, -0.36], [0.12, -0.36], [0.145, -0.34], [0.15, -0.3], [0.15, 0.1], [0.14, 0.12], [0, 0.12]], d.radial), mul(T(hx, hy, 0.05), toMZ), 0x3b5163, 0.3);
  for (let k = 0; k < 6; k++) add('paint', cyl(0.155, 0.155, 0.01, d.radial), mul(T(hx, hy, 0.05), toMZ, T(0, -0.29 + k * 0.06, 0)), 0x34495a, 0.3);
  add('paint', cyl(0.1, 0.11, 0.14, d.radial), mul(T(hx, hy, -0.14), toMZ), 0x5b6670, 0.25);
  add('paint', rbox(0.22, 0.2, 0.1, 0.015, R), T(hx, hy, -0.26), 0x6f7a84, 0.25);
  for (const z of [0.3, -0.2]) add('paint', rbox(0.26, 0.04, 0.06, 0.008, 1), T(hx, MID_Y + 0.06, z), YELLOW, 0.1);
  // Compensator (yellow bellows can) above the HPU
  add('paint', cyl(0.075, 0.075, 0.3, d.radial), T(hx + 0.02, hy + 0.32, 0.45, Math.PI / 2), 0xd8b024, 0.3);
  for (const z of [0.29, 0.61]) add('paint', cyl(0.08, 0.08, 0.02, d.radial), T(hx + 0.02, hy + 0.32, z, Math.PI / 2), 0x24272b);
  add('paint', box(0.04, hy + 0.32 - MID_Y, 0.04), T(hx + 0.02, (hy + 0.32 + MID_Y) / 2, 0.45), YELLOW);
  hose(add, 'rubber', [[hx + 0.02, hy + 0.32, 0.29], [hx + 0.02, hy + 0.22, 0.24], [hx + 0.02, hy + 0.1, 0.36], [hx, hy, 0.36]], 0.012, d);
  // HPU → valve pack pressure / return lines along the −Z side (between A-frame and side rail)
  for (const dz of [0, 0.03]) {
    const h = hose(add, 'rubber', [[hx, hy, -0.31], [hx + 0.06, hy - 0.04, -0.5 - dz], [-0.5, MID_Y + 0.08, -0.765 - dz], [0.4, MID_Y + 0.08, -0.765 - dz], [cx - 0.1, MID_Y + 0.215, -0.66 + dz]], 0.012, d);
    clamps(add, h, 0.012, [0.4, 0.6], d);
  }
  decal(add, 0.12, 0.06, T(hx + 0.111, hy, -0.26, 0, Math.PI / 2, 0), atlasPlacard('HYD 210 BAR'));
}

/** Monitoring camera in the mount frame (local −Z = view): everything sits behind the lens plane. */
function buildCamera(add: Adder, d: Detail): void {
  const toZ = T(0, 0, 0, Math.PI / 2); // lathe +Y → local +Z (behind the lens)
  // Housing along +Z (behind the lens): bezel at z 0.004, body to z 0.085
  const prof: [number, number][] = [[0, 0.004], [0.03, 0.004], [0.042, 0.008], [0.042, 0.02], [0.037, 0.024], [0.037, 0.072], [0.03, 0.08], [0.012, 0.085], [0, 0.085]];
  add('paint', lathe(prof, d.radial), toZ, 0x6b7279, 0.3);
  add('glass', new THREE.CircleGeometry(0.026, d.radial), T(0, 0, 0.0035, 0, Math.PI, 0));
  add('metal', cyl(0.008, 0.008, 0.025, d.small), T(0, 0, 0.095, Math.PI / 2), 0xb7a06a);
  add('metal', cyl(0.039, 0.039, 0.016, d.radial), T(0, 0, 0.05, Math.PI / 2), 0x3b4046);
}

/** LED lamp (puck) in the mount frame (local −Z = beam). */
function buildLamp(add: Adder, d: Detail, i: number): void {
  const flip = T(0, 0, 0, Math.PI / 2); // lathe +Y → local +Z (behind the lens)
  const r = 0.032;
  const prof: [number, number][] = [[0, 0.0035], [r - 0.004, 0.0035], [r, 0.006], [r, 0.012]];
  for (let y = 0.014; y < 0.034; y += 0.007) prof.push([r - 0.006, y], [r, y + 0.002], [r, y + 0.004]);
  prof.push([r - 0.008, 0.036], [0.01, 0.04], [0, 0.04]);
  add('paint', lathe(prof, d.radial), flip, 0x2a2e33, 0.25);
  add('lens', new THREE.CircleGeometry(r - 0.005, d.radial), T(0, 0, 0.004, 0, Math.PI, 0));
  add('metal', cyl(0.007, 0.007, 0.02, d.small), T(0, 0, 0.048, Math.PI / 2), 0xb7a06a);
  void i;
}

/** Camera / lamp brackets and their cables, built in the TMS frame from the anchor poses. */
function buildHarness(add: Adder, d: Detail, cam: THREE.Object3D, lamps: THREE.Object3D[]): void {
  const at = (o: THREE.Object3D, z: number) => new THREE.Vector3(0, 0, z).applyMatrix4(o.matrix);
  // Camera: clamp block on the +X/+Z corner post, cable down the post to the junction box
  const cBack = at(cam, 0.05);
  beam(add, 'paint', cBack.toArray() as V3, [1.245, cBack.y - 0.01, 0.8], 0.03, 0.03, 1, DARK);
  const cg = at(cam, 0.105);
  const c = hose(add, 'rubber', [cg.toArray() as V3, [cg.x + 0.01, cg.y - 0.04, cg.z + 0.01], [1.235, 0.35, 0.795], [1.235, -0.15, 0.795], [0.93, MID_Y + 0.14, 0.66]], 0.008, d, 0x262626);
  clamps(add, c, 0.008, [0.35, 0.6], d);
  // Lamps: yoke up to the lamp bar (x 1.2, y 0.715), cables along the bar and down the +Z side
  const ends: THREE.Vector3[] = [];
  for (const m of lamps) {
    const back = at(m, 0.025);
    const top = new THREE.Vector3(1.2, 0.698, back.z);
    beam(add, 'paint', back.toArray() as V3, top.toArray() as V3, 0.016, 0.03, 1, DARK);
    ends.push(at(m, 0.058));
  }
  const l = hose(
    add,
    'rubber',
    [ends[1].toArray() as V3, [1.21, 0.745, -0.2], [1.21, 0.745, 0.3], ends[0].toArray() as V3, [1.17, 0.72, 0.55], [1.22, 0.6, 0.79], [1.24, -0.1, 0.79], [0.93, MID_Y + 0.12, 0.56]],
    0.007,
    d,
    0x262626,
  );
  clamps(add, l, 0.007, [0.2, 0.4, 0.75], d);
}
