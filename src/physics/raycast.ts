/**
 * Exact ray tests against the site colliders (yawed boxes, capsules), shared by
 * the sonar (render/sonar.ts) and the altimeter (sim/altimeter.ts).
 */
import type { BoxCollider, CapsuleCollider } from '../sim/site';

export interface RayHit {
  t: number; // distance along the ray to the reported surface point
  cos: number; // |cos(incidence)| at that point
  fill: number; // 1 = exact hit, <1 = cone near-miss (fraction of the cone filled)
}

/** Shared scratch result (cos of incidence; fill used by the sonar's cone tests). */
export const rayHit: RayHit = { t: 0, cos: 0, fill: 0 };
const hit = rayHit;

/**
 * Exact ray / yawed box. Returns entry distance (> 0) or -1; sets hit.cos.
 * `grow` inflates the half extents (for cone tests).
 */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: BoxCollider, grow: number, maxT: number): number {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const px = ox - b.center.x;
  const pz = oz - b.center.z;
  // world -> local (same convention as collision.ts sphereBox)
  const lo = [px * c - pz * s, oy - b.center.y, px * s + pz * c];
  const ld = [dx * c - dz * s, dy, dx * s + dz * c];
  const hh = [b.half.x + grow, b.half.y + grow, b.half.z + grow];
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-12) {
      if (Math.abs(lo[k]) > hh[k]) return -1;
      continue;
    }
    let t1 = (-hh[k] - lo[k]) / ld[k];
    let t2 = (hh[k] - lo[k]) / ld[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) {
      tmin = t1;
      axis = k;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0 || tmin > maxT) return -1;
  if (tmin <= 0) return grow > 0 ? 0 : -1; // origin inside: ignore exact, near-miss at 0
  hit.cos = Math.abs(ld[axis]);
  return tmin;
}

/** Exact ray / capsule (Íñigo Quílez's formulation). Returns entry distance or -1; sets hit.cos. */
export function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cp: CapsuleCollider, maxT: number): number {
  const bax = cp.b.x - cp.a.x;
  const bay = cp.b.y - cp.a.y;
  const baz = cp.b.z - cp.a.z;
  const oax = ox - cp.a.x;
  const oay = oy - cp.a.y;
  const oaz = oz - cp.a.z;
  const ra = cp.radius;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  let t = -1;
  let capCx = 0;
  let capCy = 0;
  let capCz = 0;
  let useCap = true;
  if (a > 1e-9) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - ra * ra * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    const tb = (-b - Math.sqrt(h)) / a;
    const y = baoa + tb * bard;
    if (y > 0 && y < baba) {
      t = tb;
      useCap = false;
      // normal: from the axis point to the hit point
      const k = y / baba;
      const nx = ox + dx * t - (cp.a.x + bax * k);
      const ny = oy + dy * t - (cp.a.y + bay * k);
      const nz = oz + dz * t - (cp.a.z + baz * k);
      hit.cos = Math.abs(nx * dx + ny * dy + nz * dz) / ra;
    } else if (y <= 0) {
      capCx = cp.a.x;
      capCy = cp.a.y;
      capCz = cp.a.z;
    } else {
      capCx = cp.b.x;
      capCy = cp.b.y;
      capCz = cp.b.z;
    }
  } else {
    // ray parallel to the axis: nearest cap
    const ta = (cp.a.x - ox) * dx + (cp.a.y - oy) * dy + (cp.a.z - oz) * dz;
    const tb = (cp.b.x - ox) * dx + (cp.b.y - oy) * dy + (cp.b.z - oz) * dz;
    const pa = ta < tb ? cp.a : cp.b;
    capCx = pa.x;
    capCy = pa.y;
    capCz = pa.z;
  }
  if (useCap) {
    const ocx = ox - capCx;
    const ocy = oy - capCy;
    const ocz = oz - capCz;
    const b = dx * ocx + dy * ocy + dz * ocz;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - ra * ra;
    const h = b * b - c;
    if (h <= 0) return -1;
    t = -b - Math.sqrt(h);
    if (t > 0) {
      const nx = ox + dx * t - capCx;
      const ny = oy + dy * t - capCy;
      const nz = oz + dz * t - capCz;
      hit.cos = Math.abs(nx * dx + ny * dy + nz * dz) / ra;
    }
  }
  if (t <= 0 || t > maxT) return -1;
  return t;
}
