import { Quaternion, Vector3 } from 'three';
import { DEFAULT_ROV_PARAMS, type RovParams } from './rovParams';
import { ThrusterBank, type Wrench } from './thrusters';
import { colliderBounds, rayDownToCollider, sphereCollider } from './collision';
import type { Collider } from '../sim/site';

/**
 * 6-DOF rigid-body model of the ROV, loosely following Fossen's vector form
 *   M·ν̇ + C(ν)·ν + D(ν)·ν + g(η) = τ
 * with these documented simplifications:
 *  - diagonal rigid-body + added mass/inertia (no off-diagonal coupling);
 *  - Coriolis/centripetal kept for the rigid body only (ω × v, ω × Iω);
 *    added-mass Coriolis terms are neglected;
 *  - linear + quadratic diagonal damping on the velocity relative to the water;
 *  - drag acts at a centre of pressure offset from the CG (weathervaning, squat);
 *  - buoyancy scales with the submerged fraction near the surface;
 *  - contacts are resolved by projection with an inelastic velocity response.
 */

export interface ImpactEvent {
  /** Speed into the obstacle along the contact normal (m/s). */
  speed: number;
  kind: 'seabed' | 'structure';
  time: number;
}

export interface PhysicsEnvironment {
  /** Water velocity in world frame at the given position (m/s). */
  current(position: Vector3, out: Vector3): Vector3;
  terrainHeight(x: number, z: number): number;
  colliders: readonly Collider[];
}

const _v = new Vector3();
const _w = new Vector3();
const _f = new Vector3();
const _t = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _qInv = new Quaternion();
const _dq = new Quaternion();

/** Skid / frame corners used for seabed contact (body frame). */
const CONTACT_POINTS: [number, number, number][] = [
  [1.2, -0.8, 0.7],
  [1.2, -0.8, -0.7],
  [-1.2, -0.8, 0.7],
  [-1.2, -0.8, -0.7],
  [1.3, 0.6, 0.75],
  [1.3, 0.6, -0.75],
  [-1.3, 0.6, 0.75],
  [-1.3, 0.6, -0.75],
];
/** Spheres approximating the hull for structure contact (body frame x offsets). */
const HULL_SPHERES = [0.55, -0.55];
const HULL_RADIUS = 0.82;

export class RovPhysics {
  readonly params: RovParams;
  /** World position of the CG (m). */
  readonly position = new Vector3();
  /** Body → world rotation. */
  readonly orientation = new Quaternion();
  /** Linear velocity in body frame (m/s). */
  readonly velocity = new Vector3();
  /** Angular velocity in body frame (rad/s). */
  readonly angularVelocity = new Vector3();
  readonly thrusters: ThrusterBank;
  /** Water velocity at the vehicle, world frame (last step). */
  readonly waterVelocity = new Vector3();
  /** Last applied thruster wrench (body). */
  readonly thrustWrench: Wrench = [0, 0, 0, 0, 0, 0];
  time = 0;
  /** Submerged fraction of the hull [0, 1]. */
  submerged = 1;
  /** When true the vehicle follows `kinematicTarget` (crane / LARS). */
  kinematic = false;
  readonly kinematicTarget = new Vector3();
  kinematicYaw = 0;
  thrustersEnabled = true;
  /** Number of contacts in the last step (for UI / audio). */
  contactCount = 0;
  private readonly impacts: ImpactEvent[] = [];
  private lastImpactTime = -10;
  private readonly kinematicVel = new Vector3();

  constructor(params: RovParams = DEFAULT_ROV_PARAMS) {
    this.params = params;
    this.thrusters = new ThrusterBank(params.thrusters);
  }

  reset(position: Vector3, yaw: number): void {
    this.position.copy(position);
    this.orientation.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.thrusters.reset();
    this.time = 0;
    this.impacts.length = 0;
    this.lastImpactTime = -10;
    this.contactCount = 0;
  }

  /** Drain impact events produced since the last call. */
  takeImpacts(): ImpactEvent[] {
    const out = this.impacts.slice();
    this.impacts.length = 0;
    return out;
  }

  /** World-frame linear velocity. */
  worldVelocity(out = new Vector3()): Vector3 {
    return out.copy(this.velocity).applyQuaternion(this.orientation);
  }

  step(dt: number, env: PhysicsEnvironment): void {
    this.time += dt;
    this.thrusters.step(dt, this.thrustersEnabled);

    if (this.kinematic) {
      this.stepKinematic(dt);
      return;
    }

    const p = this.params;
    const q = this.orientation;
    _qInv.copy(q).invert();
    const v = this.velocity;
    const w = this.angularVelocity;

    // Submerged fraction from CG height relative to the free surface (y = 0).
    const halfH = p.size[1] / 2;
    this.submerged = Math.min(1, Math.max(0, (halfH - this.position.y) / p.size[1]));
    const sub = this.submerged;

    // Relative water velocity in body frame.
    env.current(this.position, this.waterVelocity);
    const cBody = _tmp.copy(this.waterVelocity).applyQuaternion(_qInv);
    const vr = _v.copy(v).sub(cBody);

    // --- Forces (body frame) ---
    const F = _f.set(0, 0, 0);
    const T = _t.set(0, 0, 0);

    // Thrusters
    this.thrusters.force.forEach((force, i) => {
      const spec = p.thrusters[i];
      const fx = spec.direction[0] * force;
      const fy = spec.direction[1] * force;
      const fz = spec.direction[2] * force;
      F.x += fx;
      F.y += fy;
      F.z += fz;
      const [px, py, pz] = spec.position;
      T.x += py * fz - pz * fy;
      T.y += pz * fx - px * fz;
      T.z += px * fy - py * fx;
    });
    this.thrustWrench[0] = F.x;
    this.thrustWrench[1] = F.y;
    this.thrustWrench[2] = F.z;
    this.thrustWrench[3] = T.x;
    this.thrustWrench[4] = T.y;
    this.thrustWrench[5] = T.z;

    // Hydrodynamic damping (in air it is negligible: scale by submerged fraction).
    const dampScale = 0.02 + 0.98 * sub;
    const dx = -(p.linDamp[0] * vr.x + p.quadDamp[0] * Math.abs(vr.x) * vr.x) * dampScale;
    const dy = -(p.linDamp[1] * vr.y + p.quadDamp[1] * Math.abs(vr.y) * vr.y) * dampScale;
    const dz = -(p.linDamp[2] * vr.z + p.quadDamp[2] * Math.abs(vr.z) * vr.z) * dampScale;
    F.x += dx;
    F.y += dy;
    F.z += dz;
    const [cpx, cpy, cpz] = p.centerOfPressure;
    T.x += cpy * dz - cpz * dy;
    T.y += cpz * dx - cpx * dz;
    T.z += cpx * dy - cpy * dx;

    T.x -= (p.linDampRot[0] * w.x + p.quadDampRot[0] * Math.abs(w.x) * w.x) * dampScale;
    T.y -= (p.linDampRot[1] * w.y + p.quadDampRot[1] * Math.abs(w.y) * w.y) * dampScale;
    T.z -= (p.linDampRot[2] * w.z + p.quadDampRot[2] * Math.abs(w.z) * w.z) * dampScale;

    // Restoring forces: weight at CG, buoyancy at CB.
    const W = p.mass * p.gravity;
    const B = W * (1 + p.buoyancyMargin) * sub;
    const gravityBody = _tmp2.set(0, -W, 0).applyQuaternion(_qInv);
    F.add(gravityBody);
    const buoyBody = _tmp.set(0, B, 0).applyQuaternion(_qInv);
    F.add(buoyBody);
    const [bx, by, bz] = p.centerOfBuoyancy;
    T.x += by * buoyBody.z - bz * buoyBody.y;
    T.y += bz * buoyBody.x - bx * buoyBody.z;
    T.z += bx * buoyBody.y - by * buoyBody.x;

    // --- Integrate (semi-implicit Euler) ---
    const mx = p.mass + p.addedMass[0] * sub;
    const my = p.mass + p.addedMass[1] * sub;
    const mz = p.mass + p.addedMass[2] * sub;
    // Rigid-body Coriolis: v̇ = F/m − ω × v
    const cx = w.y * v.z - w.z * v.y;
    const cy = w.z * v.x - w.x * v.z;
    const cz = w.x * v.y - w.y * v.x;
    v.x += (F.x / mx - cx) * dt;
    v.y += (F.y / my - cy) * dt;
    v.z += (F.z / mz - cz) * dt;

    const Ix = p.inertia[0] + p.addedInertia[0] * sub;
    const Iy = p.inertia[1] + p.addedInertia[1] * sub;
    const Iz = p.inertia[2] + p.addedInertia[2] * sub;
    // ω × Iω (gyroscopic)
    const gx = w.y * (Iz * w.z) - w.z * (Iy * w.y);
    const gy = w.z * (Ix * w.x) - w.x * (Iz * w.z);
    const gz = w.x * (Iy * w.y) - w.y * (Ix * w.x);
    w.x += ((T.x - gx) / Ix) * dt;
    w.y += ((T.y - gy) / Iy) * dt;
    w.z += ((T.z - gz) / Iz) * dt;

    // Position (world) and orientation.
    const vw = _tmp.copy(v).applyQuaternion(q);
    this.position.addScaledVector(vw, dt);
    const angle = w.length() * dt;
    if (angle > 1e-9) {
      _dq.setFromAxisAngle(_tmp2.copy(w).normalize(), angle);
      q.multiply(_dq).normalize();
    }

    this.resolveContacts(env);
  }

  private stepKinematic(dt: number): void {
    // Smoothly follow the crane hook; keep the vehicle level.
    const prev = _tmp.copy(this.position);
    this.position.lerp(this.kinematicTarget, 1 - Math.exp(-dt * 8));
    this.kinematicVel.subVectors(this.position, prev).divideScalar(dt);
    _dq.setFromAxisAngle(_tmp2.set(0, 1, 0), this.kinematicYaw);
    this.orientation.slerp(_dq, 1 - Math.exp(-dt * 2));
    this.velocity.copy(this.kinematicVel).applyQuaternion(_qInv.copy(this.orientation).invert());
    this.angularVelocity.multiplyScalar(Math.exp(-dt * 4));
    this.submerged = Math.min(1, Math.max(0, (this.params.size[1] / 2 - this.position.y) / this.params.size[1]));
  }

  private resolveContacts(env: PhysicsEnvironment): void {
    const q = this.orientation;
    _qInv.copy(q).invert();
    this.contactCount = 0;
    const vWorld = this.worldVelocity(_w);

    const applyContact = (normal: Vector3, depth: number, kind: ImpactEvent['kind']) => {
      this.contactCount++;
      this.position.addScaledVector(normal, depth);
      const vn = vWorld.dot(normal);
      if (vn < 0) {
        if (-vn > 0.25 && this.time - this.lastImpactTime > 0.6) {
          this.impacts.push({ speed: -vn, kind, time: this.time });
          this.lastImpactTime = this.time;
        }
        // Remove normal component (slightly inelastic bounce) + friction on tangential.
        vWorld.addScaledVector(normal, -vn * 1.15);
        const friction = kind === 'seabed' ? 0.12 : 0.06;
        _tmp2.copy(normal).multiplyScalar(vWorld.dot(normal));
        const tangential = _tmp.subVectors(vWorld, _tmp2);
        vWorld.sub(tangential.multiplyScalar(friction));
      }
    };

    // Seabed: test frame corners.
    let deepest = 0;
    for (const c of CONTACT_POINTS) {
      _tmp.set(c[0], c[1], c[2]).applyQuaternion(q).add(this.position);
      const pen = env.terrainHeight(_tmp.x, _tmp.z) - _tmp.y;
      if (pen > deepest) deepest = pen;
    }
    if (deepest > 0) {
      applyContact(new Vector3(0, 1, 0), deepest, 'seabed');
      this.angularVelocity.multiplyScalar(0.96);
    }

    // Structures.
    for (const off of HULL_SPHERES) {
      const center = new Vector3(off, 0, 0).applyQuaternion(q).add(this.position);
      for (const col of env.colliders) {
        const b = colliderBounds(col);
        const reach = b.r + HULL_RADIUS;
        if (Math.abs(center.x - b.x) > reach || Math.abs(center.z - b.z) > reach || Math.abs(center.y - b.y) > reach) continue;
        const contact = sphereCollider(center, HULL_RADIUS, col);
        if (contact) {
          applyContact(contact.normal, contact.depth, 'structure');
          center.addScaledVector(contact.normal, contact.depth);
        }
      }
    }

    if (this.contactCount > 0) this.velocity.copy(vWorld).applyQuaternion(_qInv);
  }

  // --- Sensors / derived values ------------------------------------------------

  /** Depth of the CG below the surface (m, positive down). */
  get depth(): number {
    return -this.position.y;
  }

  /** Heading in degrees [0, 360): 0 = north (-Z), 90 = east (+X). */
  get heading(): number {
    const f = _tmp.set(1, 0, 0).applyQuaternion(this.orientation);
    const h = (Math.atan2(f.x, -f.z) * 180) / Math.PI;
    return (h + 360) % 360;
  }

  /** Pitch in degrees, nose up positive. */
  get pitch(): number {
    const f = _tmp.set(1, 0, 0).applyQuaternion(this.orientation);
    return (Math.asin(Math.max(-1, Math.min(1, f.y))) * 180) / Math.PI;
  }

  /** Roll in degrees, starboard down positive. */
  get roll(): number {
    const r = _tmp.set(0, 0, 1).applyQuaternion(this.orientation);
    const u = _tmp2.set(0, 1, 0).applyQuaternion(this.orientation);
    return (Math.atan2(-r.y, u.y) * 180) / Math.PI;
  }

  /** Yaw rate in deg/s, + = turning right (clockwise from above). */
  get yawRate(): number {
    // body ω projected on world up; + about +Y is counter-clockwise → negate.
    const wWorld = _tmp.copy(this.angularVelocity).applyQuaternion(this.orientation);
    return (-wWorld.y * 180) / Math.PI;
  }

  /**
   * Altimeter: vertical distance from the bottom of the frame to the seabed
   * or a structure below. Returns null when out of range.
   */
  altitude(env: PhysicsEnvironment, maxRange = 60): number | null {
    const bottom = _tmp.set(0, -this.params.size[1] / 2, 0).applyQuaternion(this.orientation).add(this.position);
    let d = bottom.y - env.terrainHeight(bottom.x, bottom.z);
    for (const c of env.colliders) {
      const hit = rayDownToCollider(bottom, c);
      if (hit !== null && hit < d) d = hit;
    }
    if (d > maxRange) return null;
    return Math.max(0, d);
  }
}
