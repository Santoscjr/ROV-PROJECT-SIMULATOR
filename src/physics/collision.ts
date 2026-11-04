import { Vector3 } from 'three';
import type { BoxCollider, CapsuleCollider, Collider } from '../sim/site';

export interface Contact {
  /** Unit normal pointing out of the obstacle, towards the vehicle. */
  normal: Vector3;
  depth: number;
}

const tmp = new Vector3();

/** Sphere vs. box rotated about Y. Returns null if no overlap. */
export function sphereBox(center: Vector3, r: number, box: BoxCollider): Contact | null {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  const dx = center.x - box.center.x;
  const dy = center.y - box.center.y;
  const dz = center.z - box.center.z;
  // world -> local (inverse of rotation about Y)
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const ly = dy;
  const qx = Math.max(-box.half.x, Math.min(box.half.x, lx));
  const qy = Math.max(-box.half.y, Math.min(box.half.y, ly));
  const qz = Math.max(-box.half.z, Math.min(box.half.z, lz));
  let nx = lx - qx;
  let ny = ly - qy;
  let nz = lz - qz;
  let dist = Math.hypot(nx, ny, nz);
  let depth: number;
  if (dist > 1e-6) {
    if (dist >= r) return null;
    depth = r - dist;
    nx /= dist;
    ny /= dist;
    nz /= dist;
  } else {
    // centre inside the box: push out along the axis of least penetration
    const px = box.half.x - Math.abs(lx);
    const py = box.half.y - Math.abs(ly);
    const pz = box.half.z - Math.abs(lz);
    if (px <= py && px <= pz) {
      nx = Math.sign(lx) || 1; ny = 0; nz = 0; dist = px;
    } else if (py <= pz) {
      nx = 0; ny = Math.sign(ly) || 1; nz = 0; dist = py;
    } else {
      nx = 0; ny = 0; nz = Math.sign(lz) || 1; dist = pz;
    }
    depth = dist + r;
  }
  // local -> world
  const wx = nx * c + nz * s;
  const wz = -nx * s + nz * c;
  return { normal: new Vector3(wx, ny, wz), depth };
}

export function sphereCapsule(center: Vector3, r: number, cap: CapsuleCollider): Contact | null {
  const abx = cap.b.x - cap.a.x;
  const aby = cap.b.y - cap.a.y;
  const abz = cap.b.z - cap.a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((center.x - cap.a.x) * abx + (center.y - cap.a.y) * aby + (center.z - cap.a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  tmp.set(cap.a.x + abx * t, cap.a.y + aby * t, cap.a.z + abz * t);
  const n = new Vector3().subVectors(center, tmp);
  const d = n.length();
  const rr = r + cap.radius;
  if (d >= rr) return null;
  if (d < 1e-6) n.set(0, 1, 0);
  else n.divideScalar(d);
  return { normal: n, depth: rr - d };
}

export function sphereCollider(center: Vector3, r: number, c: Collider): Contact | null {
  return c.kind === 'box' ? sphereBox(center, r, c) : sphereCapsule(center, r, c);
}

/** Cheap broad-phase bound of a collider (centre + radius). */
export function colliderBounds(c: Collider): { x: number; y: number; z: number; r: number } {
  if (c.kind === 'box') {
    return { x: c.center.x, y: c.center.y, z: c.center.z, r: Math.hypot(c.half.x, c.half.y, c.half.z) };
  }
  return {
    x: (c.a.x + c.b.x) / 2,
    y: (c.a.y + c.b.y) / 2,
    z: (c.a.z + c.b.z) / 2,
    r: Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z) / 2 + c.radius,
  };
}

/** Distance along a downward ray from `origin` to the top of a collider (for the altimeter). */
export function rayDownToCollider(origin: Vector3, c: Collider): number | null {
  if (c.kind === 'box') {
    const cs = Math.cos(c.yaw);
    const sn = Math.sin(c.yaw);
    const dx = origin.x - c.center.x;
    const dz = origin.z - c.center.z;
    const lx = dx * cs - dz * sn;
    const lz = dx * sn + dz * cs;
    if (Math.abs(lx) > c.half.x || Math.abs(lz) > c.half.z) return null;
    const top = c.center.y + c.half.y;
    return origin.y >= top ? origin.y - top : null;
  }
  // Capsule: horizontal distance from the segment.
  const abx = c.b.x - c.a.x;
  const abz = c.b.z - c.a.z;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((origin.x - c.a.x) * abx + (origin.z - c.a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = c.a.x + abx * t;
  const pz = c.a.z + abz * t;
  const h = Math.hypot(origin.x - px, origin.z - pz);
  if (h > c.radius) return null;
  const py = c.a.y + (c.b.y - c.a.y) * t + Math.sqrt(c.radius * c.radius - h * h);
  return origin.y >= py ? origin.y - py : null;
}
