/**
 * Guard rails for the procedural WC-150 ROV model (src/render/rovModel.ts):
 * the anchor objects used by the app / world / physics keep their transforms,
 * the hull stays inside the reference envelope, the camera viewpoints that
 * are not part of the model (auxiliary, tether cameras in cameras.ts) stay
 * clear of geometry, and the lamp beams leave the vehicle unobstructed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { THRUSTERS, DEFAULT_ROV_PARAMS } from '../src/physics/rovParams';
import { createRovModel, type Quality, type RovModel } from '../src/render/rovModel';
import { createTmsModel, type TmsModel } from '../src/render/tmsModel';
import { TOPHAT } from '../src/sim/topHat';

// --- helpers ------------------------------------------------------------------

/** The models draw a few CanvasTextures: a no-op 2D context is enough in node. */
function installCanvasStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  const ctx: unknown = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
        if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
        if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
        if (k === 'measureText') return () => ({ width: 10 });
        return () => {};
      },
      set: () => true,
    },
  );
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}
installCanvasStub();

function modelStats(root: THREE.Object3D): { tris: number; draws: number } {
  let tris = 0;
  let draws = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    tris += n * inst;
    draws++;
  });
  return { tris: Math.round(tris), draws };
}

/** Meshes of a model with double-sided (cloned) materials, so rays also hit back faces. */
function solidMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (!m.userData.__solid) {
      const mat = (m.material as THREE.Material).clone();
      mat.side = THREE.DoubleSide;
      m.material = mat;
      m.userData.__solid = true;
    }
    out.push(m);
  });
  return out;
}

/**
 * Closest hit (within `maxDist`) of a fan of rays around a view direction given
 * as yaw/pitch (deg) in the model frame. 'aux' = cameras.ts auxiliary convention
 * (z = +sin yaw), 'tether' = tether camera convention (z = −sin yaw).
 */
function rayFanMin(
  meshes: THREE.Object3D[],
  p: THREE.Vector3,
  yawDeg: number,
  pitchDeg: number,
  hHalf: number,
  vHalf: number,
  conv: 'aux' | 'tether',
  maxDist: number,
  step = 5,
): { dist: number; what: string } | null {
  const rc = new THREE.Raycaster();
  rc.far = maxDist;
  let best: { dist: number; what: string } | null = null;
  for (let a = -hHalf; a <= hHalf + 1e-9; a += step) {
    for (let b = -vHalf; b <= vHalf + 1e-9; b += step) {
      const yaw = THREE.MathUtils.degToRad(yawDeg + a);
      const pitch = THREE.MathUtils.degToRad(pitchDeg + b);
      const s = conv === 'aux' ? 1 : -1;
      rc.set(p, new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), s * Math.sin(yaw) * Math.cos(pitch)));
      const h = rc.intersectObjects(meshes, false)[0];
      if (h && (!best || h.distance < best.dist)) {
        best = { dist: h.distance, what: `${h.object.name || h.object.type} at ${h.distance.toFixed(3)} m, ray ${a}/${b}, ${h.point.toArray().map((v) => v.toFixed(3))}` };
      }
    }
  }
  return best;
}

/** Surface sample points of every triangle of `meshes` (world frame), spacing ≈ `s`. */
function surfacePoints(meshes: THREE.Mesh[], s: number, keep: (p: THREE.Vector3) => boolean, visit: (p: THREE.Vector3, m: THREE.Mesh) => void): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
      if (!keep(a) && !keep(b) && !keep(c)) continue;
      const k = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / s));
      for (let u = 0; u <= k; u++) {
        for (let v = 0; v <= k - u; v++) {
          const w = k - u - v;
          p.set(0, 0, 0).addScaledVector(a, u / k).addScaledVector(b, v / k).addScaledVector(c, w / k);
          if (keep(p)) visit(p, m);
        }
      }
    }
  }
}

const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const models = {} as Record<Quality, RovModel>;

beforeAll(() => {
  for (const q of QUALITIES) {
    models[q] = createRovModel({ quality: q });
    models[q].root.updateMatrixWorld(true);
  }
});

type V3 = [number, number, number];
const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
const wq = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());
function expectVec(v: THREE.Vector3, e: readonly number[], tol = 1e-4): void {
  expect(Math.abs(v.x - e[0])).toBeLessThan(tol);
  expect(Math.abs(v.y - e[1])).toBeLessThan(tol);
  expect(Math.abs(v.z - e[2])).toBeLessThan(tol);
}
function expectQuat(q: THREE.Quaternion, e: readonly number[], tol = 1e-4): void {
  // q and −q are the same rotation
  const d = Math.abs(q.x * e[0] + q.y * e[1] + q.z * e[2] + q.w * e[3]);
  expect(1 - d).toBeLessThan(tol);
}

/** Reference anchor transforms (v3.2-rc.1 model, captured before the visual refresh). */
const REF = {
  cameraTilt: { p: [1.16, -0.18, 0], q: [0, 0, 0, 1] },
  cameraEye: { p: [1.363, -0.18, 0], q: [0, 0, 0, 1] },
  lights: [
    { p: [1.08471, 0.73651, -0.50148], q: [-0.0021, 0.02992, -0.06991, 0.9971] },
    { p: [1.08471, 0.73651, 0.50148], q: [0.0021, -0.02992, -0.06991, 0.9971] },
    { p: [1.29447, -0.50497, -0.56122], q: [-0.0025, 0.02487, -0.0998, 0.99469] },
    { p: [1.29447, -0.50497, 0.56122], q: [0.0025, -0.02487, -0.0998, 0.99469] },
  ],
  /** Bounding box of the whole model (stowed arms). */
  bbox: { min: [-1.33323, -0.8795, -0.82423], max: [1.36142, 1.1956, 0.82423] },
};
/** Auxiliary / tether camera offsets and default view directions (src/render/cameras.ts). */
const AUX = { p: new THREE.Vector3(1.28, -0.42, 0.62), yaw: -8, pitch: -28 };
const TETHER_CAM = { p: new THREE.Vector3(0.55, 1.02, 0.35), yaw: 180, pitch: 22 };
/** Lamp aim applied by world.ts on top of the mount orientation (splay about Y, down about Z), deg. */
const LAMP_AIM: [number, number][] = [[9, 0], [-9, 0], [30, -10], [-30, -10]];

describe('WC-150 ROV model: anchors', () => {
  it.each(QUALITIES)('keeps the pilot camera pan/tilt and eye transforms (%s)', (q) => {
    const m = models[q];
    expectVec(wp(m.cameraTilt), REF.cameraTilt.p);
    expectQuat(wq(m.cameraTilt), REF.cameraTilt.q);
    expectVec(wp(m.cameraEye), REF.cameraEye.p);
    expectQuat(wq(m.cameraEye), REF.cameraEye.q);
    expect(m.cameraEye.parent).toBe(m.cameraTilt);
  });

  it.each(QUALITIES)('keeps the four lamp mounts (position + orientation) (%s)', (q) => {
    const m = models[q];
    expect(m.lightMounts).toHaveLength(4);
    m.lightMounts.forEach((l, i) => {
      expect(l.parent).toBe(m.root);
      expectVec(wp(l), REF.lights[i].p);
      expectQuat(wq(l), REF.lights[i].q);
    });
  });

  it.each(QUALITIES)('puts each propeller on its physics thruster, spinning about the thrust axis (%s)', (q) => {
    const m = models[q];
    expect(m.propellers).toHaveLength(THRUSTERS.length);
    THRUSTERS.forEach((t, i) => {
      const prop = m.propellers[i];
      expectVec(wp(prop), t.position);
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(prop));
      const dir = new THREE.Vector3(...t.direction).normalize();
      expect(axis.dot(dir)).toBeGreaterThan(1 - 1e-6);
    });
    // setThrust only spins the propellers about their own axis
    const before = THRUSTERS.map((_, i) => wp(m.propellers[i]));
    m.setThrust([1, -1, 0.5, 0, 1, 1, -1, 0], 0.013);
    m.root.updateMatrixWorld(true);
    THRUSTERS.forEach((t, i) => {
      expectVec(wp(m.propellers[i]), before[i].toArray());
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(m.propellers[i]));
      expect(axis.dot(new THREE.Vector3(...t.direction).normalize())).toBeGreaterThan(1 - 1e-6);
    });
    m.setThrust([0, 0, 0, 0, 0, 0, 0, 0], 0);
  });

  it.each(QUALITIES)('ends the tether bend restrictor on the physics tether attachment axis (%s)', (q) => {
    // The physics applies the tether force at params.tetherAttach and world.ts
    // draws the umbilical to that point: it must lie on the bend-restrictor axis
    // (tetherPoint local +Y), inside the restrictor, below its tip.
    const m = models[q];
    const tip = wp(m.tetherPoint);
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(m.tetherPoint));
    const attach = new THREE.Vector3(...DEFAULT_ROV_PARAMS.tetherAttach!);
    const rel = attach.clone().sub(tip);
    const along = rel.dot(axis);
    const off = rel.clone().addScaledVector(axis, -along).length();
    expect(off).toBeLessThan(0.005);
    expect(along).toBeLessThan(-0.1); // below the tip …
    expect(along).toBeGreaterThan(-0.45); // … but inside the restrictor
    // The tip sits on the aft top of the vehicle.
    // vertical, coaxial with the Top-Hat exit guide (TOPHAT.exit.x = tetherAttach.x)
    expectQuat(wq(m.tetherPoint), [0, 0, 0, 1]);
    expect(Math.abs(tip.x - TOPHAT.exit.x)).toBeLessThan(1e-6);
    expect(tip.x).toBeLessThan(-0.5);
    expect(tip.y).toBeGreaterThan(1.1);
    expect(Math.abs(tip.z)).toBeLessThan(1e-6);
  });

  it('exposes the manipulator rigs with their joint metadata', () => {
    const m = models.medium;
    expect(m.manipulators.starboard.joints).toHaveLength(7);
    expect(m.manipulators.port.joints).toHaveLength(5);
    for (const j of [...m.manipulators.starboard.joints, ...m.manipulators.port.joints]) {
      expect(['x', 'y', 'z']).toContain(j.userData.axis);
      expect(typeof j.userData.rest).toBe('number');
    }
  });
});

describe('WC-150 ROV model: envelope and budget', () => {
  it.each(QUALITIES)('stays within ±5 %% of the reference bounding box (%s)', (q) => {
    const b = new THREE.Box3().setFromObject(models[q].root);
    const size = new THREE.Vector3(...REF.bbox.max).sub(new THREE.Vector3(...REF.bbox.min));
    (['x', 'y', 'z'] as const).forEach((k, i) => {
      const tol = 0.05 * size[k];
      expect(Math.abs(b.min[k] - REF.bbox.min[i])).toBeLessThan(tol);
      expect(Math.abs(b.max[k] - REF.bbox.max[i])).toBeLessThan(tol);
    });
    // and roughly the physics envelope (L × H × W, without the topside bullet/restrictor)
    const [L, , W] = DEFAULT_ROV_PARAMS.size;
    expect(b.max.x - b.min.x).toBeLessThan(L * 1.05);
    expect(b.max.z - b.min.z).toBeLessThan(W * 1.05);
  });

  it('keeps triangle and draw-call counts within budget, increasing with quality', () => {
    const s = QUALITIES.map((q) => modelStats(models[q].root));
    // eslint-disable-next-line no-console
    console.log('ROV tris/draws', QUALITIES.map((q, i) => `${q}: ${s[i].tris}/${s[i].draws}`).join('  '));
    expect(s[0].tris).toBeLessThan(60000);
    expect(s[1].tris).toBeLessThan(90000);
    expect(s[2].tris).toBeLessThan(150000);
    expect(s[0].tris).toBeLessThan(s[1].tris);
    expect(s[1].tris).toBeLessThan(s[2].tris);
    for (const x of s) expect(x.draws).toBeLessThanOrEqual(36);
  });
});

describe('WC-150 ROV model: camera and lamp clearances', () => {
  it.each(QUALITIES)('nothing within 0.15 m in front of the auxiliary camera lens (%s)', (q) => {
    const meshes = solidMeshes(models[q].root);
    // central part of the field of view (±35° × ±25°) at the default pose and at the pan/tilt limits
    for (const [dy, dp] of [[0, 0], [-25, 0], [25, 0], [0, -20], [0, 20]]) {
      const hit = rayFanMin(meshes, AUX.p, AUX.yaw + dy, AUX.pitch + dp, 35, 25, 'aux', 0.15);
      expect(hit, `aux ${dy}/${dp}: ${hit?.what}`).toBeNull();
    }
  });

  it.each(QUALITIES)('nothing within 0.15 m in front of the tether camera lens (%s)', (q) => {
    const meshes = solidMeshes(models[q].root);
    for (const [dy, dp] of [[0, 0], [-60, 0], [60, 0], [0, -25], [0, 35]]) {
      const hit = rayFanMin(meshes, TETHER_CAM.p, TETHER_CAM.yaw + dy, TETHER_CAM.pitch + dp, 35, 25, 'tether', 0.15);
      expect(hit, `tether ${dy}/${dp}: ${hit?.what}`).toBeNull();
    }
  });

  it.each(QUALITIES)('camera viewpoints are not inside geometry (%s)', (q) => {
    const meshes = solidMeshes(models[q].root);
    for (const p of [AUX.p, TETHER_CAM.p, wp(models[q].cameraEye)]) {
      // all-round fan: nothing closer than 2 cm in any direction
      const hit = rayFanMin(meshes, p, 0, 0, 180, 85, 'aux', 0.02, 15);
      expect(hit, `${p.toArray()}: ${hit?.what}`).toBeNull();
    }
  });

  it.each(QUALITIES)('lamp beams leave the vehicle unobstructed (%s)', (q) => {
    const m = models[q];
    const meshes = solidMeshes(m.root);
    m.lightMounts.forEach((mount, i) => {
      const aim = new THREE.Object3D();
      mount.add(aim);
      aim.rotateY((LAMP_AIM[i][0] * Math.PI) / 180);
      aim.rotateZ((LAMP_AIM[i][1] * Math.PI) / 180);
      aim.updateMatrixWorld(true);
      const p = wp(aim);
      const qq = wq(aim);
      const rc = new THREE.Raycaster();
      rc.far = 1.5;
      for (let a = -25; a <= 25; a += 5) {
        for (let b = -25; b <= 25; b += 5) {
          const d = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, (a * Math.PI) / 180, (b * Math.PI) / 180)).applyQuaternion(qq);
          rc.set(p, d);
          const h = rc.intersectObjects(meshes, false)[0];
          expect(h, `lamp ${i} ray ${a}/${b} hits ${h?.object.name} at ${h?.distance.toFixed(3)}`).toBeUndefined();
        }
      }
      mount.remove(aim);
    });
  });

  it.each(QUALITIES)('the pilot camera sees past its dome at every tilt (%s)', (q) => {
    const m = models[q];
    const meshes = solidMeshes(m.root).filter((x) => x.parent !== m.cameraTilt);
    for (const tilt of [-70, -40, -10, 0, 30]) {
      m.cameraTilt.rotation.z = (tilt * Math.PI) / 180;
      m.root.updateMatrixWorld(true);
      const p = wp(m.cameraEye);
      const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(wq(m.cameraEye));
      const yaw = Math.atan2(dir.z, dir.x) * (180 / Math.PI);
      const pitch = Math.asin(dir.y) * (180 / Math.PI);
      const hit = rayFanMin(meshes, p, yaw, pitch, 15, 15, 'aux', 0.15);
      expect(hit, `tilt ${tilt}: ${hit?.what}`).toBeNull();
    }
    m.cameraTilt.rotation.z = 0;
    m.root.updateMatrixWorld(true);
  });
});

// =============================================================================
// Top-Hat TMS
// =============================================================================

const TMS_REF = {
  camera: { p: [1.18, 0.52, 0.72], q: [-0.20379, 0.53644, 0.13535, 0.8077] },
  lights: [
    { p: [1.12, 0.66, 0.4], q: [-0.21163, 0.59387, 0.16573, 0.75833] },
    { p: [1.2, 0.66, -0.25], q: [-0.17164, 0.73024, 0.19872, 0.63071] },
  ],
};
const tmsModels = {} as Record<Quality, TmsModel>;

beforeAll(() => {
  for (const q of QUALITIES) {
    tmsModels[q] = createTmsModel({ quality: q });
    tmsModels[q].root.updateMatrixWorld(true);
  }
});

function isUnder(o: THREE.Object3D | null, parent: THREE.Object3D): boolean {
  for (let x = o; x; x = x.parent) if (x === parent) return true;
  return false;
}

describe('Top-Hat TMS model: anchors and API', () => {
  it.each(QUALITIES)('keeps the camera mount, lamp mounts, exit and lift points (%s)', (q) => {
    const t = tmsModels[q];
    expectVec(wp(t.cameraMount), TMS_REF.camera.p);
    expectQuat(wq(t.cameraMount), TMS_REF.camera.q);
    expect(t.lightMounts).toHaveLength(2);
    t.lightMounts.forEach((l, i) => {
      expectVec(wp(l), TMS_REF.lights[i].p);
      expectQuat(wq(l), TMS_REF.lights[i].q);
    });
    expectVec(wp(t.exitPoint), TOPHAT.exit.toArray());
    expectVec(wp(t.liftPoint), TOPHAT.lift.toArray());
  });

  it('drives the drum, the stored cable and the level wind', () => {
    const t = createTmsModel({ quality: 'medium' });
    const p0 = wp(t.drum);
    t.setDrumAngle(0.7);
    t.root.updateMatrixWorld(true);
    expectVec(wp(t.drum), p0.toArray());
    expectQuat(t.drum.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.7).toArray());

    const pack = t.root.getObjectByName('tms-cable-pack')!;
    expect(pack).toBeTruthy();
    expect(isUnder(pack, t.drum)).toBe(true);
    const radius = (f: number) => {
      t.setStoredFraction(f);
      t.root.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(pack);
      return (b.max.y - b.min.y) / 2;
    };
    const r1 = radius(1);
    const rHalf = radius(0.5);
    const rLow = radius(0.05);
    expect(r1).toBeGreaterThan(rHalf);
    expect(rHalf).toBeGreaterThan(rLow);
    // the full pack stays inside the drum flanges
    const flange = t.root.getObjectByName('tms-drum-flanges')!;
    const fb = new THREE.Box3().setFromObject(flange);
    expect(r1).toBeLessThan((fb.max.y - fb.min.y) / 2 - 0.01);
    t.setStoredFraction(0);
    expect(pack.visible).toBe(false);

    const lw = t.root.getObjectByName('tms-level-wind')!;
    expect(lw).toBeTruthy();
    t.setLevelWind(-1);
    t.root.updateMatrixWorld(true);
    const a = wp(lw);
    t.setLevelWind(1);
    t.root.updateMatrixWorld(true);
    const b = wp(lw);
    expect(b.z - a.z).toBeGreaterThan(0.6);
    expect(Math.abs(b.x - a.x)).toBeLessThan(1e-9);
    expect(Math.abs(b.y - a.y)).toBeLessThan(1e-9);
    expect(Math.max(Math.abs(a.z), Math.abs(b.z))).toBeLessThan(TOPHAT.half.z - 0.2);
    t.dispose();
  });

  it('keeps triangle and draw-call counts within budget', () => {
    const s = QUALITIES.map((q) => modelStats(tmsModels[q].root));
    // eslint-disable-next-line no-console
    console.log('TMS tris/draws', QUALITIES.map((q, i) => `${q}: ${s[i].tris}/${s[i].draws}`).join('  '));
    expect(s[2].tris).toBeLessThan(60000);
    expect(s[0].tris).toBeLessThanOrEqual(s[2].tris);
    for (const x of s) expect(x.draws).toBeLessThanOrEqual(24);
  });
});

describe('Top-Hat TMS model: consistency with the physics (TOPHAT)', () => {
  it.each(QUALITIES)('fits the TOPHAT body envelope (%s)', (q) => {
    const t = tmsModels[q];
    t.setStoredFraction(1);
    const b = new THREE.Box3().setFromObject(t.root);
    expect(b.max.x).toBeLessThan(TOPHAT.half.x + 0.1);
    expect(b.min.x).toBeGreaterThan(-TOPHAT.half.x - 0.1);
    expect(b.max.z).toBeLessThan(TOPHAT.half.z + 0.1);
    expect(b.min.z).toBeGreaterThan(-TOPHAT.half.z - 0.1);
    expect(b.max.y).toBeLessThan(TOPHAT.lift.y + 0.2);
    expect(b.min.y).toBeGreaterThan(-TOPHAT.half.y - 0.25);
    t.setStoredFraction(0.8);
  });

  it.each(QUALITIES)('has the latch receptacle around TOPHAT.receptacle, clear of the docked bullet (%s)', (q) => {
    const meshes = solidMeshes(tmsModels[q].root);
    const rc = new THREE.Raycaster();
    const o = TOPHAT.receptacle.clone().add(new THREE.Vector3(0, 0.03, 0));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      rc.set(o, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      rc.far = 0.35;
      expect(rc.intersectObjects(meshes, false)[0], `receptacle wall ${k}`).toBeTruthy();
    }
    // straight up: the latch body, above the docked bullet tip
    const bulletTipY = TOPHAT.bulletTop.y - TOPHAT.dockDrop;
    rc.set(TOPHAT.receptacle, new THREE.Vector3(0, 1, 0));
    rc.far = 1;
    const h = rc.intersectObjects(meshes, false)[0];
    expect(h).toBeTruthy();
    expect(TOPHAT.receptacle.y + h.distance).toBeGreaterThan(bulletTipY + 0.02);
    expect(TOPHAT.receptacle.y + h.distance).toBeLessThan(bulletTipY + 0.25);
  });

  it('surrounds the docked ROV top with the docking skirt', () => {
    const meshes = solidMeshes(tmsModels.medium.root);
    const rc = new THREE.Raycaster();
    rc.far = 0.45;
    const y = -TOPHAT.dockDrop + 0.62; // just below the ROV foam top
    for (const [p, d] of [
      [[1.0, y, 0], [1, 0, 0]],
      [[-1.0, y, 0], [-1, 0, 0]],
      [[0.3, y, 0.55], [0, 0, 1]],
      [[-0.3, y, -0.55], [0, 0, -1]],
    ] as [V3, V3][]) {
      rc.set(new THREE.Vector3(...p), new THREE.Vector3(...d));
      expect(rc.intersectObjects(meshes, false)[0], `skirt ${d}`).toBeTruthy();
    }
  });

  it('does not intersect the docked (latched) ROV', () => {
    // ROV in the TMS frame when latched: CG at (0, −dockDrop, 0), same heading.
    const rov = createRovModel({ quality: 'medium' });
    rov.root.position.set(0, -TOPHAT.dockDrop, 0);
    rov.root.updateMatrixWorld(true);
    const tms = createTmsModel({ quality: 'medium' });
    tms.setStoredFraction(1);
    tms.root.updateMatrixWorld(true);
    const V = 0.02;
    const key = (p: THREE.Vector3) => `${Math.floor(p.x / V)},${Math.floor(p.y / V)},${Math.floor(p.z / V)}`;
    const occupied = new Set<string>();
    const rovMeshes: THREE.Mesh[] = [];
    rov.root.traverse((o) => (o as THREE.Mesh).isMesh && rovMeshes.push(o as THREE.Mesh));
    surfacePoints(rovMeshes, 0.012, (p) => p.y > -TOPHAT.half.y - 0.3, (p) => occupied.add(key(p)));
    const tmsMeshes: THREE.Mesh[] = [];
    tms.root.traverse((o) => {
      // the tether itself runs into the ROV bend restrictor: not a clash
      if ((o as THREE.Mesh).isMesh && !o.name.startsWith('tms-cable-span')) tmsMeshes.push(o as THREE.Mesh);
    });
    const clashes: string[] = [];
    surfacePoints(tmsMeshes, 0.012, (p) => p.y < -0.15, (p, m) => {
      if (occupied.has(key(p)) && clashes.length < 12) clashes.push(`${m.name || m.parent?.name} @ ${p.toArray().map((v) => v.toFixed(2))}`);
    });
    expect(clashes, clashes.join('\n')).toEqual([]);
    rov.dispose();
    tms.dispose();
  });
});

describe('Top-Hat TMS model: monitoring camera and lamps', () => {
  it.each(QUALITIES)('nothing within 0.15 m in front of the TMS camera lens (%s)', (q) => {
    const t = tmsModels[q];
    const meshes = solidMeshes(t.root);
    const p = wp(t.cameraMount);
    const qq = wq(t.cameraMount);
    const rc = new THREE.Raycaster();
    rc.far = 0.15;
    for (let a = -40; a <= 40; a += 5) {
      for (let b = -30; b <= 30; b += 5) {
        const d = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler((b * Math.PI) / 180, (a * Math.PI) / 180, 0, 'YXZ')).applyQuaternion(qq);
        rc.set(p, d);
        const h = rc.intersectObjects(meshes, false)[0];
        expect(h, `ray ${a}/${b}: ${h?.object.name}`).toBeUndefined();
      }
    }
  });

  it.each(QUALITIES)('the TMS camera frames the drum, the level wind and the exit guide (%s)', (q) => {
    const t = tmsModels[q];
    const meshes = solidMeshes(t.root);
    const cam = new THREE.PerspectiveCamera(84, 16 / 9, 0.08, 50);
    cam.position.copy(wp(t.cameraMount));
    cam.quaternion.copy(wq(t.cameraMount));
    cam.updateMatrixWorld(true);
    const lw = t.root.getObjectByName('tms-level-wind')!;
    const guide = t.root.getObjectByName('tms-exit-guide');
    const rc = new THREE.Raycaster();
    const seen = (target: THREE.Vector3, owner: THREE.Object3D | null, tol: number) => {
      const ndc = target.clone().project(cam);
      if (Math.abs(ndc.x) > 0.95 || Math.abs(ndc.y) > 0.95 || ndc.z > 1) return `outside the frame (${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)})`;
      const d = target.clone().sub(cam.position);
      rc.set(cam.position, d.clone().normalize());
      rc.far = d.length() + 0.5;
      const h = rc.intersectObjects(meshes, false)[0];
      if (!h) return 'nothing hit';
      if (owner && isUnder(h.object, owner)) return null;
      if (h.distance >= d.length() - tol) return null;
      return `occluded by ${h.object.name || h.object.parent?.name} at ${h.distance.toFixed(2)}/${d.length().toFixed(2)}`;
    };
    for (const f of [1, 0.6, 0.2]) {
      t.setStoredFraction(f);
      for (const x of [-1, 0, 1]) {
        t.setLevelWind(x);
        t.root.updateMatrixWorld(true);
        expect(seen(wp(t.drum), t.drum, 0), `drum f=${f}`).toBeNull();
        expect(seen(wp(lw), lw, 0.05), `level wind f=${f} x=${x}`).toBeNull();
        // exit guide (bellmouth + roller box): most of its camera-facing side is in view
        let vis = 0;
        let tot = 0;
        const why: string[] = [];
        for (const gx of [-0.15, -0.075, 0, 0.075, 0.15]) {
          for (const gy of [0.03, 0.07, 0.11, 0.15]) {
            const r = seen(TOPHAT.exit.clone().add(new THREE.Vector3(gx, gy, 0.12)), guide ?? null, 0.25);
            tot++;
            if (r === null) vis++;
            else why.push(r);
          }
        }
        expect(vis / tot, `exit guide f=${f} x=${x}: ${why.slice(0, 3).join('; ')}`).toBeGreaterThan(0.6);
      }
    }
    t.setStoredFraction(0.8);
    t.setLevelWind(0);
  });

  it.each(QUALITIES)('the TMS lamp beams are unobstructed near the lamps (%s)', (q) => {
    const t = tmsModels[q];
    const meshes = solidMeshes(t.root);
    const rc = new THREE.Raycaster();
    rc.far = 0.5;
    t.lightMounts.forEach((m, i) => {
      const p = wp(m);
      const qq = wq(m);
      for (let a = -25; a <= 25; a += 5) {
        for (let b = -25; b <= 25; b += 5) {
          if (Math.hypot(a, b) > 25) continue; // circular cone
          const d = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler((b * Math.PI) / 180, (a * Math.PI) / 180, 0, 'YXZ')).applyQuaternion(qq);
          rc.set(p, d);
          const h = rc.intersectObjects(meshes, false)[0];
          expect(h, `lamp ${i} ray ${a}/${b}: ${h?.object.name} @ ${h?.point.toArray().map((v) => v.toFixed(3))}`).toBeUndefined();
        }
      }
    });
  });
});
