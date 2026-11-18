/**
 * Single-beam altimeter (echosounder) model — see docs/research/sonar.md.
 *
 * Fictitious 500 kHz unit, beam cone 6° (typical of commercial altimeters),
 * fixed to the vehicle body (it tilts with pitch/roll). It reports the NEAREST
 * echo inside the cone, so over slopes it reads short, over a boulder it jumps
 * to the boulder top, and with the vehicle tilted it reads the slant range.
 * Seven rays sample the cone (axis + 6 on the 3° half-angle rim). Range
 * 0.3–50 m: beyond it there is no echo (null); inside the blind zone it reads
 * the minimum.
 */
import { Vector3 } from 'three';
import type { Collider } from './site';
import { rayBox, rayCapsule } from '../physics/raycast';

export const ALTIMETER = { coneDeg: 6, rays: 7, minRange: 0.3, maxRange: 50 } as const;

export interface AltimeterWorld {
  terrainHeight: (x: number, z: number) => number;
  colliders: readonly Collider[];
  /** Spatial query for dense colliders (rocks): fills `out` with colliders overlapping the box. */
  queryColliders?: (minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[]) => void;
}

const _dir = new Vector3();
const _u = new Vector3();
const _v = new Vector3();
const _near: Collider[] = [];

/** Distance along a ray to the height field (secant/Newton on f(t) = y(t) − h(x(t), z(t))). */
export function rayTerrain(o: Vector3, d: Vector3, h: (x: number, z: number) => number, maxT: number): number {
  const f = (t: number) => o.y + d.y * t - h(o.x + d.x * t, o.z + d.z * t);
  const f0 = f(0);
  if (f0 <= 0) return 0;
  if (d.y >= -1e-3) return Infinity;
  // First guess: vertical gap over the descent rate, then a few secant refinements.
  let t0 = 0;
  let t1 = Math.min(maxT, f0 / -d.y);
  let y0 = f0;
  let y1 = f(t1);
  for (let k = 0; k < 8 && Math.abs(y1) > 1e-4; k++) {
    const den = y1 - y0;
    if (Math.abs(den) < 1e-9) break;
    const t2 = Math.max(0, t1 - (y1 * (t1 - t0)) / den);
    t0 = t1;
    y0 = y1;
    t1 = t2;
    y1 = f(t1);
  }
  return Math.abs(y1) < 0.01 && t1 <= maxT ? t1 : t1 > maxT ? Infinity : t1;
}

function rayCollider(o: Vector3, d: Vector3, c: Collider, maxT: number): number {
  const t = c.kind === 'box' ? rayBox(o.x, o.y, o.z, d.x, d.y, d.z, c, 0, maxT) : rayCapsule(o.x, o.y, o.z, d.x, d.y, d.z, c, maxT);
  return t > 0 ? t : Infinity;
}

/**
 * Altitude reading (m) from a transducer at `origin` looking along `axis`
 * (unit, world; the body's down direction). Returns null when nothing is
 * within range.
 */
export function altimeterReading(origin: Vector3, axis: Vector3, world: AltimeterWorld, cfg: { coneDeg: number; rays: number; minRange: number; maxRange: number } = ALTIMETER): number | null {
  const half = ((cfg.coneDeg / 2) * Math.PI) / 180;
  // Orthonormal basis around the beam axis.
  _u.set(1, 0, 0);
  if (Math.abs(axis.x) > 0.9) _u.set(0, 0, 1);
  _u.cross(axis).normalize();
  _v.copy(axis).cross(_u).normalize();
  // Dense colliders (rocks) inside the cone's footprint box.
  _near.length = 0;
  if (world.queryColliders) {
    const reach = cfg.maxRange;
    const ex = axis.x * reach;
    const ez = axis.z * reach;
    const spread = Math.tan(half) * reach + 1;
    world.queryColliders(Math.min(origin.x, origin.x + ex) - spread, Math.min(origin.z, origin.z + ez) - spread, Math.max(origin.x, origin.x + ex) + spread, Math.max(origin.z, origin.z + ez) + spread, _near);
  }
  let best = Infinity;
  for (let i = 0; i < cfg.rays; i++) {
    if (i === 0) _dir.copy(axis);
    else {
      const a = ((i - 1) / (cfg.rays - 1)) * Math.PI * 2;
      const s = Math.sin(half);
      _dir.copy(axis).multiplyScalar(Math.cos(half)).addScaledVector(_u, s * Math.cos(a)).addScaledVector(_v, s * Math.sin(a)).normalize();
    }
    best = Math.min(best, rayTerrain(origin, _dir, world.terrainHeight, cfg.maxRange));
    for (const c of world.colliders) best = Math.min(best, rayCollider(origin, _dir, c, cfg.maxRange));
    for (const c of _near) best = Math.min(best, rayCollider(origin, _dir, c, cfg.maxRange));
  }
  if (!Number.isFinite(best) || best > cfg.maxRange) return null;
  return Math.max(cfg.minRange, best);
}
