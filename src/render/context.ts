import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  TubeGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { terrainHeight } from '../sim/terrain';
import { fouledMaterial } from './materials';
import type { GraphicsQuality } from '../config/settings';

/**
 * Distant offshore context, seen only as dark silhouettes when the water is
 * clear enough: a riser base with a flexible riser rising (lazy wave) towards
 * a production unit out of sight, an FPSO mooring line and a second
 * wellhead structure. One merged mesh, no shadows. These objects are scenery
 * only (no colliders); their positions are exported for the physics if needed.
 */
export const CONTEXT_LAYOUT = {
  riserBase: { x: -14, z: -72, size: { x: 4, y: 2.2, z: 3 } },
  wellhead2: { x: 52, z: -106, size: { x: 5, y: 4, z: 5 } },
  riserRadius: 0.18,
  mooringRadius: 0.11,
};

export function createContext(quality: GraphicsQuality): Mesh {
  const parts: BufferGeometry[] = [];
  const put = (geo: BufferGeometry, color: Color, m?: Matrix4) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (m) g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new BufferAttribute(c, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    parts.push(g);
  };
  const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
  const ground = (x: number, z: number) => terrainHeight(x, z);
  const radial = quality === 'low' ? 6 : 8;
  const yellow = new Color(0.62, 0.48, 0.14);
  const black = new Color(0.08, 0.08, 0.08);
  const rust = new Color(0.25, 0.17, 0.11);

  // Riser base: mudmat + frame + gooseneck.
  const rb = CONTEXT_LAYOUT.riserBase;
  const rbY = ground(rb.x, rb.z);
  put(new BoxGeometry(rb.size.x + 0.8, 0.3, rb.size.z + 0.8), new Color(0.45, 0.44, 0.4), at(rb.x, rbY + 0.15, rb.z));
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) put(new BoxGeometry(0.25, rb.size.y, 0.25), yellow, at(rb.x + (sx * rb.size.x) / 2, rbY + rb.size.y / 2, rb.z + (sz * rb.size.z) / 2));
  put(new BoxGeometry(rb.size.x, 0.25, rb.size.z), yellow, at(rb.x, rbY + rb.size.y, rb.z));
  put(new CylinderGeometry(0.35, 0.35, 1.4, radial), new Color(0.5, 0.5, 0.5), at(rb.x - 1, rbY + 1.2, rb.z));

  // Flexible riser in a lazy-wave configuration towards the west, up into the dark.
  const riser = new CatmullRomCurve3(
    [
      [rb.x - 1, rbY + 1.8, rb.z],
      [rb.x - 3, rbY + 3, rb.z + 3],
      [-20, -104, -60],
      [-23, -92, -50],
      [-25, -82, -41],
      [-27, -77, -32],
      [-29, -79, -24],
      [-31, -72, -16],
      [-40, -46, 0],
      [-60, -16, 20],
      [-76, 0, 30],
    ].map(([x, y, z]) => new Vector3(x, y, z)),
  );
  put(new TubeGeometry(riser, quality === 'low' ? 60 : 110, CONTEXT_LAYOUT.riserRadius, radial, false), black);
  // Distributed buoyancy modules on the hog bend.
  const buoy = new CylinderGeometry(0.55, 0.55, 0.9, radial + 2);
  for (let t = 0.42; t < 0.66; t += 0.012) {
    const p = riser.getPointAt(t);
    const d = riser.getTangentAt(t);
    put(buoy.clone(), new Color(0.7, 0.42, 0.1), new Matrix4().compose(p, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d), new Vector3(1, 1, 1)));
  }

  // Mooring line: chain on the seabed to the touchdown point, then up to the unit.
  const pts: Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const x = -8 - i * 5;
    const z = -150 + i * 2;
    pts.push(new Vector3(x, ground(x, z) + 0.1, z));
  }
  pts.push(new Vector3(-55, -112, -134), new Vector3(-80, -88, -122), new Vector3(-115, -50, -105), new Vector3(-160, -6, -86));
  const mooring = new CatmullRomCurve3(pts);
  put(new TubeGeometry(mooring, quality === 'low' ? 50 : 90, CONTEXT_LAYOUT.mooringRadius, 5, false), rust);

  // Second wellhead protection structure.
  const wh = CONTEXT_LAYOUT.wellhead2;
  const whY = ground(wh.x, wh.z);
  const hx = wh.size.x / 2;
  put(new BoxGeometry(wh.size.x + 0.6, 0.3, wh.size.z + 0.6), new Color(0.45, 0.44, 0.4), at(wh.x, whY + 0.15, wh.z));
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) put(new BoxGeometry(0.3, wh.size.y, 0.3), yellow, at(wh.x + sx * hx, whY + wh.size.y / 2, wh.z + sz * hx));
  for (const y of [0.5, wh.size.y]) {
    for (const s of [-1, 1]) {
      put(new BoxGeometry(wh.size.x, 0.25, 0.25), yellow, at(wh.x, whY + y, wh.z + s * hx));
      put(new BoxGeometry(0.25, 0.25, wh.size.z), yellow, at(wh.x + s * hx, whY + y, wh.z));
    }
  }
  for (let i = -2; i <= 2; i++) put(new BoxGeometry(0.15, 0.15, wh.size.z), yellow, at(wh.x + i * (hx / 2.5), whY + wh.size.y + 0.15, wh.z));
  put(new CylinderGeometry(0.5, 0.5, 2.6, radial + 2), new Color(0.5, 0.5, 0.5), at(wh.x, whY + 1.6, wh.z));
  put(new BoxGeometry(1.2, 1.2, 1.0), new Color(0.5, 0.5, 0.5), at(wh.x, whY + 2.4, wh.z));
  void black;

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  const mesh = new Mesh(merged, fouledMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 }, { amount: 0.5, sediment: 0.6, chips: 0, relief: 0 }));
  mesh.name = 'offshore-context';
  return mesh;
}
