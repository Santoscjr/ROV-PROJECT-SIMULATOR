/**
 * Geometry / material helpers and sub-assemblies for the procedural
 * work-class ROV model (see rovModel.ts for the vehicle layout).
 *
 * All static geometry is funnelled through `GeoSet` buckets (one per material)
 * so the whole vehicle collapses into a handful of draw calls. Every piece is
 * normalised to non-indexed position/normal/uv/color/wear so `mergeGeometries`
 * always sees compatible attributes. Vertex colours are only honoured by the
 * materials created with `vertexColors: true` (metal, paint); the `wear`
 * attribute drives the chipped-paint shader patch (see rovTextures.ts).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ArmRig, Quality } from './rovModel';
import { applySurfaceShader, type RovTextures } from './rovTextures';

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export interface Detail {
  /** Radial segments for large round parts (ducts, housings). */
  radial: number;
  /** Radial segments for small round parts (rods, connectors). */
  small: number;
  /** RoundedBoxGeometry segments. */
  round: number;
  /** Tubular segments for cables / hoses. */
  tube: number;
  /** Bevel segments for extruded foam. */
  bevel: number;
  /** Small hardware (bolt heads, hose clamps) on/off. */
  bolts: boolean;
}

export function detailFor(q: Quality): Detail {
  switch (q) {
    case 'low':
      return { radial: 12, small: 6, round: 1, tube: 10, bevel: 1, bolts: false };
    case 'medium':
      return { radial: 20, small: 10, round: 1, tube: 16, bevel: 2, bolts: true };
    default:
      return { radial: 32, small: 12, round: 2, tube: 24, bevel: 3, bolts: true };
  }
}

// ---------------------------------------------------------------------------
// Geometry buckets
// ---------------------------------------------------------------------------

const _col = new THREE.Color();
/** Default wear for parts without explicit wear: enough for scratches, no chips. */
export const BASE_WEAR = 0.12;

/**
 * Clone `src` into a merge-friendly non-indexed geometry, transformed and
 * vertex-coloured, with a `wear` attribute (x = paint wear, y = side-grime mask).
 * A geometry may bring its own `wear` attribute; geometries tagged
 * `userData.edgeWear` (rounded boxes) get extra wear on their rounded edges.
 */
export function prepare(src: THREE.BufferGeometry, matrix?: THREE.Matrix4, color = 0xffffff, wear?: number): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const own = !!g.attributes.wear;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(own && name === 'wear')) g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  _col.setHex(color);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = _col.r;
    c[i * 3 + 1] = _col.g;
    c[i * 3 + 2] = _col.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  let w: Float32Array | null = null;
  if (!own) {
    w = new Float32Array(n * 2);
    const base = wear ?? BASE_WEAR;
    const edge = src.userData.edgeWear === true;
    const nor = g.attributes.normal;
    for (let i = 0; i < n; i++) {
      let e = base;
      if (edge) {
        const m = Math.max(Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i)));
        e = Math.max(base, Math.min(1, (1 - m) / 0.3));
      }
      w[i * 2] = e;
    }
  }
  if (matrix) g.applyMatrix4(matrix);
  if (w) {
    const nor = g.attributes.normal;
    for (let i = 0; i < n; i++) w[i * 2 + 1] = 1 - Math.abs(nor.getY(i));
    g.setAttribute('wear', new THREE.Float32BufferAttribute(w, 2));
  }
  g.clearGroups();
  return g;
}

export class GeoSet {
  private parts: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4, color?: number, wear?: number): void {
    this.parts.push(prepare(geo, matrix, color, wear));
    geo.dispose();
  }
  get empty(): boolean {
    return this.parts.length === 0;
  }
  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!merged) throw new Error('rovModel: geometry merge failed');
    merged.computeBoundingSphere();
    return merged;
  }
}

export type MatKey = 'frame' | 'foam' | 'rubber' | 'metal' | 'paint' | 'lens' | 'glass' | 'label';
export const MAT_KEYS: MatKey[] = ['frame', 'foam', 'rubber', 'metal', 'paint', 'lens', 'glass', 'label'];

/** Adds a geometry to a material bucket with a (local) transform, colour and wear. */
export type Adder = (key: MatKey, geo: THREE.BufferGeometry, m?: THREE.Matrix4, color?: number, wear?: number) => void;

/** An adder that pre-multiplies every transform by `base`. */
export function sub(add: Adder, base: THREE.Matrix4): Adder {
  return (k, g, m, c, w) => add(k, g, m ? base.clone().multiply(m) : base.clone(), c, w);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
export const AX = new THREE.Vector3(1, 0, 0);
export const AY = new THREE.Vector3(0, 1, 0);
export const AZ = new THREE.Vector3(0, 0, 1);

export function T(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, _one);
}

export function TQ(p: THREE.Vector3, q: THREE.Quaternion): THREE.Matrix4 {
  return new THREE.Matrix4().compose(p, q, _one);
}

export function mul(...ms: THREE.Matrix4[]): THREE.Matrix4 {
  const r = new THREE.Matrix4();
  for (const m of ms) r.multiply(m);
  return r;
}

export type V3 = [number, number, number];
export const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Matrix placing a geometry whose long axis is `axis` so it spans a→b. */
export function spanMatrix(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): { m: THREE.Matrix4; len: number } {
  const d = b.clone().sub(a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(axis, d.normalize());
  return { m: TQ(a.clone().add(b).multiplyScalar(0.5), q), len };
}

// ---------------------------------------------------------------------------
// Primitive factories
// ---------------------------------------------------------------------------

export function rbox(w: number, h: number, d: number, r: number, seg: number): THREE.BufferGeometry {
  const rr = Math.min(r, Math.min(w, h, d) * 0.49);
  const g = new RoundedBoxGeometry(w, h, d, seg, rr);
  g.userData.edgeWear = true;
  return g;
}

/** Plain box (12 triangles) for thin bars and small hardware. */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

export function cyl(rTop: number, rBot: number, h: number, seg: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false);
}

/** Surface of revolution around +Y from (radius, y) pairs. Go bottom→top on the outside for outward normals. */
export function lathe(pts: [number, number][], seg: number): THREE.BufferGeometry {
  return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}

/** Rectangular tube (rounded box) from a to b. */
export function beam(add: Adder, key: MatKey, a: V3, b: V3, w: number, h: number, seg: number, color?: number): void {
  const { m, len } = spanMatrix(v3(a), v3(b), AX);
  add(key, rbox(len, h, w, Math.min(w, h) * 0.18, seg), m, color);
}

/** Round rod from a to b. */
export function rod(add: Adder, key: MatKey, a: V3, b: V3, r: number, seg: number, color?: number): void {
  const { m, len } = spanMatrix(v3(a), v3(b), AY);
  add(key, cyl(r, r, len, seg), m, color);
}

/** Flexible hose / cable through points. Returns the curve (for clamps). */
export function hose(add: Adder, key: MatKey, pts: V3[], r: number, d: Detail, color?: number): THREE.Curve<THREE.Vector3> {
  const curve = new THREE.CatmullRomCurve3(pts.map(v3), false, 'centripetal');
  add(key, new THREE.TubeGeometry(curve, d.tube, r, Math.max(5, d.small - 4), false), undefined, color, 0);
  return curve;
}

/** Band clamps around a hose at the given curve parameters (0..1). */
export function clamps(add: Adder, curve: THREE.Curve<THREE.Vector3>, r: number, ts: number[], d: Detail): void {
  if (!d.bolts) return;
  for (const t of ts) {
    const q = new THREE.Quaternion().setFromUnitVectors(AY, curve.getTangentAt(t));
    add('metal', cyl(r + 0.005, r + 0.005, 0.016, 8), TQ(curve.getPointAt(t), q), 0xb9bec3, 0.2);
  }
}

/** Hex bolt heads on a plate: points are (u, v) in the plate's local XZ plane, heads face local +Y. */
export function bolts(add: Adder, m: THREE.Matrix4, pts: [number, number][], d: Detail, r = 0.0095): void {
  if (!d.bolts) return;
  for (const [u, v] of pts) add('metal', cyl(r, r, 0.008, 6), mul(m, T(u, 0.004, v)), 0xc7ccd1, 0.25);
}

/** Bolt pattern along the perimeter of a w×d rectangle (nx along u, nz along v). */
export function boltRect(w: number, d: number, nx: number, nz: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < nx; i++) {
    const u = -w / 2 + (w * i) / Math.max(1, nx - 1);
    pts.push([u, -d / 2], [u, d / 2]);
  }
  for (let j = 1; j < nz - 1; j++) {
    const v = -d / 2 + (d * j) / Math.max(1, nz - 1);
    pts.push([-w / 2, v], [w / 2, v]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface MaterialSet {
  mats: Record<MatKey, THREE.MeshStandardMaterial>;
  dome: THREE.MeshPhysicalMaterial;
}

export function createMaterials(envMap: THREE.Texture | null, tex: RovTextures): MaterialSet {
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ envMap, ...p });
  const mats: Record<MatKey, THREE.MeshStandardMaterial> = {
    frame: std({ name: 'rov-frame', color: 0x4b535b, metalness: 0.3, roughness: 0.5 }),
    foam: std({
      name: 'rov-foam',
      color: 0xf29a05,
      metalness: 0,
      roughness: 0.78,
      normalMap: tex.foamNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
    }),
    rubber: std({
      name: 'rov-rubber',
      color: 0x222427,
      metalness: 0,
      roughness: 0.86,
      normalMap: tex.rubberNormal,
      normalScale: new THREE.Vector2(0.35, 0.35),
    }),
    metal: std({ name: 'rov-metal', color: 0xffffff, vertexColors: true, metalness: 0.7, roughness: 0.36 }),
    paint: std({ name: 'rov-paint', color: 0xffffff, vertexColors: true, metalness: 0.12, roughness: 0.5 }),
    lens: new THREE.MeshPhysicalMaterial({
      name: 'rov-lamp-lens',
      color: 0xffffff,
      map: tex.led,
      emissive: new THREE.Color(0xfff3e2),
      emissiveMap: tex.led,
      emissiveIntensity: 0,
      metalness: 0,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMap,
    }),
    glass: std({ name: 'rov-glass', color: 0x0e1115, metalness: 0.5, roughness: 0.08 }),
    label: std({
      name: 'rov-decal',
      map: tex.label,
      transparent: true,
      metalness: 0,
      roughness: 0.62,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      depthWrite: false,
    }),
  };
  applySurfaceShader(mats.frame, tex.detail, {
    wearColor: 0x939aa1, wearAmount: 0.42, wearMetalness: 0.9, wearRoughness: 0.32, grime: 0.35, brushed: 0.5, scale: 5,
  });
  applySurfaceShader(mats.foam, tex.detail, {
    wearColor: 0x9a978e, wearAmount: 0.42, wearMetalness: 0, wearRoughness: 0.95, grime: 0.4, brushed: 0, scale: 2.6,
  });
  applySurfaceShader(mats.rubber, tex.detail, {
    wearColor: 0x333333, wearAmount: 0, wearMetalness: 0, wearRoughness: 0.9, grime: 0.25, brushed: 0, scale: 2,
  });
  applySurfaceShader(mats.metal, tex.detail, {
    wearColor: 0xdde1e5, wearAmount: 0.45, wearMetalness: 1, wearRoughness: 0.18, grime: 0.2, brushed: 1, scale: 4,
  });
  applySurfaceShader(mats.paint, tex.detail, {
    wearColor: 0xa7adb3, wearAmount: 0.5, wearMetalness: 0.85, wearRoughness: 0.3, grime: 0.3, brushed: 0.25, scale: 5,
  });
  const dome = new THREE.MeshPhysicalMaterial({
    name: 'rov-camera-dome',
    color: 0xdfeaf2,
    metalness: 0,
    roughness: 0.03,
    transparent: true,
    opacity: 0.28,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMap,
    depthWrite: false,
  });
  return { mats, dome };
}

// ---------------------------------------------------------------------------
// Thruster (local frame: +Y = thrust direction, origin = propeller plane)
// ---------------------------------------------------------------------------

export const DUCT_RI = 0.11;
export const DUCT_HALF = 0.13;
/** Distance from the propeller plane to the end of the motor pod. */
export const POD_END = 0.26;

/**
 * Static parts of one thruster: painted Kort nozzle, motor pod with stator
 * struts, mounting lugs (local ±X), power connector and, optionally, a guard
 * grille over the open (non-pod) end.
 * `podSign` puts the motor pod on the +Y (1) or −Y (−1) side.
 */
export function thrusterStatic(add: Adder, podSign: 1 | -1, d: Detail, grille: boolean): void {
  const R = DUCT_RI;
  const h = DUCT_HALF;
  // Kort nozzle cross-section, counter-clockwise in (r, y): outside going up
  // (towards the rounded inlet lip at +Y), inside going down to the sharp outlet.
  const duct: [number, number][] = [
    [R + 0.012, -h],
    [R + 0.03, -0.08],
    [R + 0.05, 0.0],
    [R + 0.062, 0.075],
    [R + 0.062, 0.105],
    [R + 0.05, h - 0.004],
    [R + 0.03, h],
    [R + 0.012, h - 0.012],
    [R + 0.003, 0.08],
    [R, 0.03],
    [R, -0.06],
    [R + 0.005, -h + 0.004],
    [R + 0.012, -h],
  ];
  add('paint', lathe(duct, d.radial), undefined, 0x2a2d31, 0.2);
  // Thin bright wear ring at the inlet
  add('metal', new THREE.TorusGeometry(R + 0.035, 0.006, 5, d.radial), T(0, h - 0.002, 0, Math.PI / 2), 0x9aa1a8);

  const flip = podSign === 1 ? new THREE.Matrix4() : T(0, 0, 0, Math.PI);
  const p = sub(add, flip);
  const pod: [number, number][] = [
    [0, 0.035],
    [0.05, 0.035],
    [0.062, 0.048],
    [0.066, 0.075],
    [0.066, 0.21],
    [0.072, 0.215],
    [0.072, 0.232],
    [0.058, 0.245],
    [0.036, POD_END - 0.002],
    [0, POD_END],
  ];
  p('paint', lathe(pod, d.radial), undefined, 0x2c3137, 0.16);
  // Cooling ribs band
  p('paint', cyl(0.069, 0.069, 0.012, d.radial), T(0, 0.12, 0), 0x464d55);
  p('paint', cyl(0.069, 0.069, 0.012, d.radial), T(0, 0.15, 0), 0x464d55);
  // Stator struts
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const m = mul(T(0, 0.075, 0, 0, a, 0), T(0.088, 0, 0));
    p('paint', rbox(0.05, 0.055, 0.012, 0.004, 1), m, 0x2c3137);
  }
  // Penetrator / connector at the pod end
  p('metal', cyl(0.018, 0.018, 0.04, d.small), T(0, POD_END + 0.012, 0), 0xb7a06a);
  // Mounting lugs on the duct (local ±X) with bolts
  for (const s of [1, -1]) {
    add('frame', rbox(0.075, 0.12, 0.06, 0.01, d.round), T(s * (R + 0.09), -0.05, 0));
    bolts(add, T(s * (R + 0.09), -0.05, 0.03, Math.PI / 2), [[0, -0.035], [0, 0.035]], d, 0.008);
  }
  if (grille) {
    // Guard grille: ring + parallel bars across the open end
    const gy = -podSign * (h + 0.012);
    const gr = R + 0.028;
    add('frame', new THREE.TorusGeometry(gr, 0.007, 5, d.radial), T(0, gy, 0, Math.PI / 2));
    for (let k = -3; k <= 3; k++) {
      const x = k * 0.034;
      const len = 2 * Math.sqrt(gr * gr - x * x);
      add('frame', box(0.007, 0.007, len), T(x, gy, 0));
    }
    add('frame', box(2 * gr, 0.008, 0.008), T(0, gy - podSign * 0.008, 0));
  }
}

/** Propeller (hub + blades), spins about local +Y. */
export function propellerGeometry(d: Detail, podSign: 1 | -1): THREE.BufferGeometry {
  const set = new GeoSet();
  const hub: [number, number][] = [
    [0, -0.078],
    [0.018, -0.07],
    [0.034, -0.048],
    [0.042, -0.02],
    [0.044, 0.025],
    [0.03, 0.03],
    [0, 0.03],
  ];
  const hubGeo = lathe(hub, Math.max(10, d.radial >> 1));
  if (podSign === -1) hubGeo.rotateX(Math.PI);
  set.add(hubGeo, undefined, 0x24272b, 0.35);
  const blades = 5;
  const outline = new THREE.Shape();
  outline.moveTo(0.035, -0.022);
  outline.bezierCurveTo(0.07, -0.034, 0.1, -0.03, DUCT_RI - 0.006, -0.008);
  outline.bezierCurveTo(DUCT_RI - 0.003, 0.012, 0.09, 0.03, 0.06, 0.03);
  outline.lineTo(0.035, 0.02);
  outline.closePath();
  const pitch = 0.62;
  for (let i = 0; i < blades; i++) {
    const g = new THREE.ExtrudeGeometry(outline, {
      depth: 0.005,
      bevelEnabled: false,
      curveSegments: Math.max(3, d.small >> 1),
    });
    g.translate(0, 0, -0.0025);
    const m = mul(T(0, 0, 0, 0, (i / blades) * Math.PI * 2, 0), T(0, 0, 0, Math.PI / 2 - pitch, 0, 0));
    set.add(g, m, 0xa8793c, 0.3);
  }
  return set.build();
}

// ---------------------------------------------------------------------------
// LED light head (local +X = beam). Body to `add`, lens to the lens bucket.
// ---------------------------------------------------------------------------

export function lightHead(add: Adder, d: Detail): void {
  const toX = T(0, 0, 0, 0, 0, -Math.PI / 2);
  const prof: [number, number][] = [[0, -0.085], [0.028, -0.085], [0.036, -0.078]];
  for (let y = -0.07; y < -0.004; y += 0.013) {
    prof.push([0.038, y], [0.05, y + 0.002], [0.05, y + 0.006], [0.038, y + 0.008]);
  }
  prof.push([0.046, 0.0], [0.05, 0.004], [0.05, 0.02], [0.044, 0.026], [0.038, 0.026], [0.038, 0.02], [0, 0.02]);
  add('paint', lathe(prof, d.radial), toX, 0x2a2e33, 0.25);
  add('lens', new THREE.CircleGeometry(0.037, d.radial), T(0.021, 0, 0, 0, Math.PI / 2, 0));
  // Rear gland
  add('metal', cyl(0.012, 0.012, 0.04, d.small), mul(toX, T(0, -0.1, 0)), 0xb7a06a);
  // Trunnion yoke
  for (const s of [1, -1]) add('frame', rbox(0.06, 0.05, 0.01, 0.004, 1), T(-0.03, 0, s * 0.057));
  add('frame', rbox(0.03, 0.012, 0.125, 0.004, 1), T(-0.05, -0.03, 0));
}

// ---------------------------------------------------------------------------
// Small camera (local +X = view)
// ---------------------------------------------------------------------------

export function smallCamera(add: Adder, d: Detail, r = 0.032, len = 0.14): void {
  const toX = T(0, 0, 0, 0, 0, -Math.PI / 2);
  const prof: [number, number][] = [
    [0, -len / 2],
    [r * 0.75, -len / 2],
    [r, -len / 2 + 0.01],
    [r, len / 2 - 0.02],
    [r * 1.12, len / 2 - 0.016],
    [r * 1.12, len / 2],
    [r * 0.7, len / 2],
    [0, len / 2],
  ];
  add('paint', lathe(prof, d.radial), toX, 0x6b7279);
  add('glass', new THREE.CircleGeometry(r * 0.62, d.small + 2), T(len / 2 + 0.001, 0, 0, 0, Math.PI / 2, 0));
  add('metal', cyl(0.009, 0.009, 0.03, d.small), mul(toX, T(0, -len / 2 - 0.012, 0)), 0xb7a06a);
}

// ---------------------------------------------------------------------------
// Pilot camera head (inside cameraTilt; local +X = view, tilt about Z)
// ---------------------------------------------------------------------------

export const PILOT_DOME_X = 0.125;
export const PILOT_DOME_R = 0.058;

export function pilotCameraHead(set: GeoSet, d: Detail): THREE.BufferGeometry {
  const toX = T(0, 0, 0, 0, 0, -Math.PI / 2);
  const prof: [number, number][] = [
    [0, -0.11],
    [0.045, -0.11],
    [0.058, -0.1],
    [0.062, -0.08],
    [0.062, 0.1],
    [0.071, 0.104],
    [0.071, PILOT_DOME_X],
    [0.056, PILOT_DOME_X],
    [0, PILOT_DOME_X],
  ];
  set.add(lathe(prof, d.radial), toX, 0x9aa1a8);
  // Black band + lens barrel visible through the dome
  set.add(cyl(0.0635, 0.0635, 0.03, d.radial), mul(toX, T(0, -0.04, 0)), 0x1b1d20);
  set.add(cyl(0.03, 0.034, 0.05, d.radial), mul(toX, T(0, PILOT_DOME_X + 0.02, 0)), 0x15171a);
  set.add(new THREE.CircleGeometry(0.024, d.radial), T(PILOT_DOME_X + 0.0455, 0, 0, 0, Math.PI / 2, 0), 0x0b2238, 0);
  // Tilt trunnions
  for (const s of [1, -1]) {
    set.add(cyl(0.028, 0.028, 0.03, d.small), T(0, 0, s * 0.072, Math.PI / 2), 0x2f3338);
  }
  set.add(cyl(0.012, 0.012, 0.04, d.small), mul(toX, T(0, -0.13, 0)), 0xb7a06a);
  return set.build();
}

export function pilotDome(d: Detail): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(PILOT_DOME_R, d.radial, Math.max(6, d.radial >> 2), 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateZ(-Math.PI / 2);
  g.translate(PILOT_DOME_X, 0, 0);
  return g;
}

// ---------------------------------------------------------------------------
// Manipulators
// ---------------------------------------------------------------------------

type JointAxis = 'x' | 'y' | 'z';
type PartAdder = (g: THREE.BufferGeometry, m?: THREE.Matrix4, c?: number) => void;

interface JointSpec {
  name: string;
  axis: JointAxis;
  /** Offset from parent joint (parent local frame). */
  offset: V3;
  /** Rest angle about `axis` (stowed pose). */
  rest: number;
  build: (add: PartAdder) => void;
}

const TI = 0x7f868d;
const GRAB = 0x5f666e;
const ACT = 0x18191b;
const CHROME = 0xdfe4e8;

function actuator(add: PartAdder, a: V3, b: V3, r: number, d: Detail): void {
  const A = v3(a);
  const B = v3(b);
  const split = A.clone().lerp(B, 0.6);
  const s1 = spanMatrix(A, split, AY);
  add(cyl(r, r, s1.len, d.small), s1.m, ACT);
  const s2 = spanMatrix(split, B, AY);
  add(cyl(r * 0.5, r * 0.5, s2.len, d.small), s2.m, CHROME);
  add(new THREE.SphereGeometry(r * 0.9, d.small, d.small >> 1), T(B.x, B.y, B.z), ACT);
}

function knuckle(r: number, w: number, d: Detail): [THREE.BufferGeometry, THREE.Matrix4] {
  return [cyl(r, r, w, d.radial), T(0, 0, 0, Math.PI / 2)];
}

function starboardSpecs(d: Detail): JointSpec[] {
  const R = d.round;
  return [
    {
      name: 'azimuth', axis: 'y', offset: [0, 0, 0], rest: -0.15,
      build: (a) => {
        a(cyl(0.07, 0.07, 0.018, d.radial), T(0, 0.009, 0), ACT);
        a(cyl(0.054, 0.058, 0.1, d.radial), T(0, 0.068, 0), TI);
        a(rbox(0.06, 0.06, 0.13, 0.012, R), T(0.0, 0.12, 0), TI);
      },
    },
    {
      name: 'shoulder', axis: 'z', offset: [0.02, 0.13, 0], rest: 1.25,
      build: (a) => {
        const [k, km] = knuckle(0.046, 0.135, d);
        a(k, km, TI);
        a(rbox(0.32, 0.07, 0.06, 0.016, R), T(0.18, 0, 0), TI);
        a(rbox(0.07, 0.075, 0.1, 0.012, R), T(0.33, 0, 0), TI);
        actuator(a, [0.02, -0.055, 0], [0.27, -0.052, 0], 0.02, d);
      },
    },
    {
      name: 'elbow', axis: 'z', offset: [0.36, 0, 0], rest: -2.85,
      build: (a) => {
        const [k, km] = knuckle(0.042, 0.11, d);
        a(k, km, TI);
        a(rbox(0.27, 0.06, 0.055, 0.014, R), T(0.15, 0, 0), TI);
        actuator(a, [0.04, 0.05, 0], [0.22, 0.045, 0], 0.016, d);
      },
    },
    {
      name: 'wristPitch', axis: 'z', offset: [0.3, 0, 0], rest: 0.7,
      build: (a) => {
        const [k, km] = knuckle(0.034, 0.085, d);
        a(k, km, TI);
        a(rbox(0.06, 0.05, 0.05, 0.01, R), T(0.035, 0, 0), TI);
      },
    },
    {
      name: 'wristYaw', axis: 'y', offset: [0.065, 0, 0], rest: 0,
      build: (a) => {
        a(cyl(0.03, 0.03, 0.07, d.radial), undefined, ACT);
        a(rbox(0.05, 0.045, 0.05, 0.01, R), T(0.03, 0, 0), TI);
      },
    },
    {
      name: 'wristRotate', axis: 'x', offset: [0.055, 0, 0], rest: 0,
      build: (a) => {
        a(cyl(0.034, 0.034, 0.09, d.radial), T(0.045, 0, 0, 0, 0, -Math.PI / 2), TI);
        a(cyl(0.036, 0.036, 0.015, d.radial), T(0.02, 0, 0, 0, 0, -Math.PI / 2), ACT);
        a(rbox(0.035, 0.075, 0.055, 0.01, R), T(0.105, 0, 0), ACT);
        // fixed finger
        a(rbox(0.085, 0.016, 0.034, 0.006, R), T(0.16, -0.024, 0), TI);
        a(rbox(0.022, 0.026, 0.034, 0.006, R), T(0.198, -0.012, 0, 0, 0, 0.4), ACT);
      },
    },
    {
      name: 'jaw', axis: 'z', offset: [0.12, 0.024, 0], rest: -0.05,
      build: (a) => {
        a(rbox(0.085, 0.016, 0.034, 0.006, R), T(0.04, 0, 0), TI);
        a(rbox(0.022, 0.026, 0.034, 0.006, R), T(0.078, -0.012, 0, 0, 0, -0.4), ACT);
      },
    },
  ];
}

function portSpecs(d: Detail): JointSpec[] {
  const R = d.round;
  return [
    {
      name: 'azimuth', axis: 'y', offset: [0, 0, 0], rest: 0.15,
      build: (a) => {
        a(cyl(0.078, 0.078, 0.02, d.radial), T(0, 0.01, 0), ACT);
        a(cyl(0.062, 0.066, 0.1, d.radial), T(0, 0.07, 0), GRAB);
        a(rbox(0.07, 0.07, 0.15, 0.014, R), T(0, 0.125, 0), GRAB);
      },
    },
    {
      name: 'shoulder', axis: 'z', offset: [0.02, 0.135, 0], rest: 1.25,
      build: (a) => {
        const [k, km] = knuckle(0.055, 0.15, d);
        a(k, km, GRAB);
        a(rbox(0.3, 0.085, 0.072, 0.018, R), T(0.17, 0, 0), GRAB);
        actuator(a, [0.03, -0.065, 0], [0.26, -0.06, 0], 0.024, d);
      },
    },
    {
      name: 'elbow', axis: 'z', offset: [0.32, 0, 0], rest: -2.85,
      build: (a) => {
        const [k, km] = knuckle(0.05, 0.12, d);
        a(k, km, GRAB);
        a(rbox(0.24, 0.075, 0.066, 0.016, R), T(0.13, 0, 0), GRAB);
        actuator(a, [0.04, 0.058, 0], [0.2, 0.054, 0], 0.019, d);
      },
    },
    {
      name: 'wristRotate', axis: 'x', offset: [0.26, 0, 0], rest: 0,
      build: (a) => {
        a(cyl(0.042, 0.042, 0.08, d.radial), T(0.04, 0, 0, 0, 0, -Math.PI / 2), GRAB);
        a(cyl(0.044, 0.044, 0.014, d.radial), T(0.012, 0, 0, 0, 0, -Math.PI / 2), ACT);
        a(rbox(0.045, 0.1, 0.085, 0.012, R), T(0.1, 0, 0), ACT);
        for (const z of [-0.026, 0.026]) {
          a(rbox(0.09, 0.018, 0.022, 0.006, R), T(0.16, -0.035, z, 0, 0, -0.12), GRAB);
          a(rbox(0.04, 0.02, 0.022, 0.006, R), T(0.215, -0.022, z, 0, 0, 0.6), ACT);
        }
      },
    },
    {
      name: 'jaw', axis: 'z', offset: [0.115, 0.03, 0], rest: 0.02,
      build: (a) => {
        a(rbox(0.09, 0.02, 0.026, 0.007, R), T(0.045, 0.004, 0, 0, 0, 0.1), GRAB);
        a(rbox(0.04, 0.022, 0.026, 0.007, R), T(0.1, -0.006, 0, 0, 0, -0.6), ACT);
      },
    },
  ];
}

/**
 * Build a manipulator as a joint hierarchy. Each joint is an Object3D whose
 * `userData` holds `{ axis: 'x'|'y'|'z', rest: number }`; animate by setting
 * `joint.rotation[axis] = rest + delta`. The arm's mesh pieces are children
 * of the joints (one merged mesh per joint).
 */
export function buildArm(side: 'port' | 'starboard', d: Detail, mat: THREE.Material): ArmRig & { meshes: THREE.Mesh[] } {
  const specs = side === 'starboard' ? starboardSpecs(d) : portSpecs(d);
  const base = new THREE.Object3D();
  base.name = `${side}-manipulator-base`;
  const joints: THREE.Object3D[] = [];
  const meshes: THREE.Mesh[] = [];
  let parent: THREE.Object3D = base;
  for (const s of specs) {
    const j = new THREE.Object3D();
    j.name = `${side}-${s.name}`;
    j.position.set(s.offset[0], s.offset[1], s.offset[2]);
    j.rotation[s.axis] = s.rest;
    j.userData = { axis: s.axis, rest: s.rest };
    const set = new GeoSet();
    s.build((g, m, c) => set.add(g, m, c));
    const mesh = new THREE.Mesh(set.build(), mat);
    mesh.name = `${j.name}-mesh`;
    mesh.castShadow = mesh.receiveShadow = true;
    j.add(mesh);
    meshes.push(mesh);
    parent.add(j);
    joints.push(j);
    parent = j;
  }
  return { base, joints, meshes };
}
