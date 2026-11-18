import { Quaternion, Vector3 } from 'three';
import { DEFAULT_ROV_PARAMS, type RovParams } from './rovParams';
import { ThrusterBank, type Wrench } from './thrusters';
import { colliderBounds, sphereCollider } from './collision';
import { ALTIMETER, altimeterReading } from '../sim/altimeter';
import type { TetherForceProvider } from './tether';
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
 *  - contacts are resolved by projection with an inelastic velocity response
 *    and Coulomb friction (velocity-level, see resolveContacts);
 *  - optional umbilical force (env.tether) applied at the termination point;
 *  - thruster inflow (advance loss) uses the velocity relative to the water
 *    at each thruster (v + ω × r − current).
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
  /**
   * Optional spatial query of the static seabed colliders (boulders, rock
   * berm — sim/environment.ts): appends to `out` (and returns it) every
   * collider whose horizontal footprint overlaps the xz box. Used by the
   * contacts and the altimeter in addition to `colliders`.
   */
  queryColliders?(minX: number, minZ: number, maxX: number, maxZ: number, out: Collider[]): Collider[];
  /** Optional umbilical; its force acts at `params.tetherAttach` (body). */
  tether?: TetherForceProvider;
}

/** Seabed contact friction coefficient (skids on silt/sand, approximate). */
const MU_SEABED = 0.35;
/** Hull against steel structures. */
const MU_STRUCTURE = 0.2;
/** Normal speed (m/s) above which a contact bounces (restitution) and counts as an impact. */
const IMPACT_SPEED = 0.25;
/** Thruster jet reach for seabed disturbance (m, vertical distance thruster → seabed). */
const WASH_REACH = 3.5;
/** Horizontal jets only scour when the thruster is within this height of the seabed (m). */
const WASH_REACH_HORIZONTAL = 1.2;

const _v = new Vector3();
const _w = new Vector3();
const _f = new Vector3();
const _t = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _ta = new Vector3();
const _tv = new Vector3();
const _tf = new Vector3();
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
/** Horizontal reach of the hull-sphere centres from the CG (m). */
const HULL_EXTENT = 0.55;
/** Scratch list for spatial collider queries. */
const _near: Collider[] = [];

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
  /**
   * Max speed (m/s) of the kinematic approach towards the target, on top of
   * the target's own motion (latch pull-in: no jump, the vehicle is drawn in
   * smoothly while still following a moving TMS).
   */
  kinematicMaxSpeed = 0.3;
  private readonly kinematicPrevTarget = new Vector3();
  private kinematicPrevValid = false;
  thrustersEnabled = true;
  /** Number of contacts in the last step (for UI / audio). */
  contactCount = 0;
  /**
   * Silt disturbance by thruster wash / skid contact near the seabed, 0..1,
   * smoothed (fast rise, slow decay). For the renderer (plume, turbidity).
   */
  seabedDisturbance = 0;
  /** Seabed point under the vehicle where the disturbance originates (world). */
  readonly seabedDisturbancePoint = new Vector3();
  /** Last umbilical force on the vehicle (world, N); zero without env.tether. */
  readonly tetherForce = new Vector3();
  /** Umbilical termination in body frame (m). */
  readonly tetherAttach = new Vector3();
  private readonly impacts: ImpactEvent[] = [];
  private slideSpeed = 0;
  private impactKick = 0;
  private lastImpactTime = -10;
  private readonly kinematicVel = new Vector3();

  constructor(params: RovParams = DEFAULT_ROV_PARAMS) {
    this.params = params;
    this.thrusters = new ThrusterBank(params.thrusters, params.powerBudget);
    const ta = params.tetherAttach ?? [0, 1.1, 0];
    this.tetherAttach.set(ta[0], ta[1], ta[2]);
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
    this.seabedDisturbance = 0;
    this.slideSpeed = 0;
    this.impactKick = 0;
    this.tetherForce.set(0, 0, 0);
    this.kinematicPrevValid = false;
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

    if (this.kinematic) {
      this.thrusters.inflow.fill(0);
      this.thrusters.step(dt, this.thrustersEnabled);
      this.stepKinematic(dt);
      this.stepTether(dt, env, false);
      this.updateSeabedDisturbance(dt, env);
      return;
    }
    this.kinematicPrevValid = false;

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

    // Thruster inflow (advance loss): (vr + ω × r)·d at each thruster.
    const inflow = this.thrusters.inflow;
    for (let i = 0; i < p.thrusters.length; i++) {
      const spec = p.thrusters[i];
      const [px, py, pz] = spec.position;
      const ux = vr.x + w.y * pz - w.z * py;
      const uy = vr.y + w.z * px - w.x * pz;
      const uz = vr.z + w.x * py - w.y * px;
      inflow[i] = (ux * spec.direction[0] + uy * spec.direction[1] + uz * spec.direction[2]) * sub;
    }
    this.thrusters.step(dt, this.thrustersEnabled);

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

    // Umbilical at the termination point.
    if (this.stepTether(dt, env, true)) {
      const fb = _tf.copy(this.tetherForce).applyQuaternion(_qInv);
      const r = this.tetherAttach;
      F.add(fb);
      T.x += r.y * fb.z - r.z * fb.y;
      T.y += r.z * fb.x - r.x * fb.z;
      T.z += r.x * fb.y - r.y * fb.x;
    }

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

    this.resolveContacts(env, dt);
    this.updateSeabedDisturbance(dt, env);
  }

  /** Steps env.tether (if any). Returns true when a force should be applied. */
  private stepTether(dt: number, env: PhysicsEnvironment, apply: boolean): boolean {
    if (!env.tether) {
      this.tetherForce.set(0, 0, 0);
      return false;
    }
    const q = this.orientation;
    const r = this.tetherAttach;
    const w = this.angularVelocity;
    const attach = _ta.copy(r).applyQuaternion(q).add(this.position);
    // Velocity of the attach point: q·(v + ω × r)
    const vel = _tv
      .set(w.y * r.z - w.z * r.y, w.z * r.x - w.x * r.z, w.x * r.y - w.y * r.x)
      .add(this.velocity)
      .applyQuaternion(q);
    env.tether.step(dt, attach, vel, this.tetherForce);
    if (!apply) return false;
    return this.tetherForce.lengthSq() > 0;
  }

  /**
   * Seabed disturbance from the thruster jets pointing at the bottom (jet =
   * opposite to thrust), with a quadratic fall-off up to WASH_REACH, plus a
   * weaker scouring term from horizontal jets very close to the bottom and
   * from skids sliding / impacting the seabed. Uses one terrain sample.
   */
  private updateSeabedDisturbance(dt: number, env: PhysicsEnvironment): void {
    const pos = this.position;
    const ground = env.terrainHeight(pos.x, pos.z);
    this.seabedDisturbancePoint.set(pos.x, ground, pos.z);
    const hCg = pos.y - ground;
    let raw = 0;
    if (hCg < WASH_REACH + 2 && pos.y < 0) {
      const q = this.orientation;
      const specs = this.params.thrusters;
      const force = this.thrusters.force;
      for (let i = 0; i < specs.length; i++) {
        const f = force[i];
        const spec = specs[i];
        const frac = f >= 0 ? f / spec.maxForward : -f / spec.maxReverse;
        if (frac < 0.01) continue;
        const jet = _tmp.set(spec.direction[0], spec.direction[1], spec.direction[2]).applyQuaternion(q);
        if (f > 0) jet.negate(); // the jet leaves opposite to the thrust
        const h = hCg + _tmp2.set(spec.position[0], spec.position[1], spec.position[2]).applyQuaternion(q).y;
        const down = Math.max(0, -jet.y);
        const fv = Math.max(0, 1 - Math.max(0, h) / WASH_REACH);
        const fh = Math.max(0, 1 - Math.max(0, h) / WASH_REACH_HORIZONTAL);
        raw += frac * (down * fv * fv + 0.3 * Math.sqrt(Math.max(0, 1 - down * down)) * fh * fh);
      }
      raw *= 0.5; // two vertical thrusters at full right above the bottom ≈ 1
    }
    raw += Math.min(0.6, this.slideSpeed * 1.5);
    raw = Math.min(1, raw);
    const tau = raw > this.seabedDisturbance ? 0.25 : 2.0;
    this.seabedDisturbance += (raw - this.seabedDisturbance) * (1 - Math.exp(-dt / tau));
    if (this.impactKick > this.seabedDisturbance) this.seabedDisturbance = this.impactKick;
    this.impactKick = 0;
    this.slideSpeed = 0;
  }

  private stepKinematic(dt: number): void {
    // Smoothly follow the crane hook / TMS; keep the vehicle level.
    // 1) carry along with the target's own motion (a target jump > 1 m in one
    //    step is a re-placement, not a motion: not carried);
    // 2) close the remaining gap exponentially (8 1/s), rate-limited to
    //    kinematicMaxSpeed so a capture far from the dock pose is a smooth pull-in.
    const prev = _tmp.copy(this.position);
    const target = this.kinematicTarget;
    if (this.kinematicPrevValid) {
      _tmp2.subVectors(target, this.kinematicPrevTarget);
      if (_tmp2.lengthSq() < 1) this.position.add(_tmp2);
    }
    this.kinematicPrevTarget.copy(target);
    this.kinematicPrevValid = true;
    _tmp2.subVectors(target, this.position).multiplyScalar(1 - Math.exp(-dt * 8));
    const maxStep = this.kinematicMaxSpeed * dt;
    const len = _tmp2.length();
    if (len > maxStep) _tmp2.multiplyScalar(maxStep / len);
    this.position.add(_tmp2);
    this.kinematicVel.subVectors(this.position, prev).divideScalar(dt);
    _dq.setFromAxisAngle(_tmp2.set(0, 1, 0), this.kinematicYaw);
    this.orientation.slerp(_dq, 1 - Math.exp(-dt * 2));
    this.velocity.copy(this.kinematicVel).applyQuaternion(_qInv.copy(this.orientation).invert());
    this.angularVelocity.multiplyScalar(Math.exp(-dt * 4));
    this.submerged = Math.min(1, Math.max(0, (this.params.size[1] / 2 - this.position.y) / this.params.size[1]));
  }

  private resolveContacts(env: PhysicsEnvironment, dt = 1 / 120): void {
    const q = this.orientation;
    _qInv.copy(q).invert();
    this.contactCount = 0;
    const vWorld = this.worldVelocity(_w);
    const p = this.params;
    // Coulomb friction at velocity level: the normal velocity removed in one
    // step equals N·dt/m_n, so a tangential change of μ·N·dt/m_t is
    // μ·|Δv_n|·m_n/m_t (heave vs. mean horizontal mass incl. added mass).
    const mN = p.mass + p.addedMass[1];
    const mT = p.mass + 0.5 * (p.addedMass[0] + p.addedMass[2]);
    const massRatio = mN / mT;

    const applyContact = (normal: Vector3, depth: number, kind: ImpactEvent['kind']) => {
      this.contactCount++;
      this.position.addScaledVector(normal, depth);
      const vn = vWorld.dot(normal);
      if (vn < 0) {
        if (-vn > IMPACT_SPEED && this.time - this.lastImpactTime > 0.6) {
          this.impacts.push({ speed: -vn, kind, time: this.time });
          this.lastImpactTime = this.time;
          if (kind === 'seabed') this.impactKick = Math.max(this.impactKick, Math.min(1, -vn / 0.8));
        }
        // Remove the normal component; only real impacts bounce (no resting jitter).
        const restitution = -vn > IMPACT_SPEED ? 0.15 : 0;
        const dvn = -vn * (1 + restitution);
        vWorld.addScaledVector(normal, dvn);
        const mu = kind === 'seabed' ? MU_SEABED : MU_STRUCTURE;
        _tmp2.copy(normal).multiplyScalar(vWorld.dot(normal));
        const tangential = _tmp.subVectors(vWorld, _tmp2);
        const vt = tangential.length();
        if (vt > 1e-9) {
          const dvt = Math.min(vt, mu * dvn * massRatio);
          vWorld.addScaledVector(tangential, -dvt / vt);
          if (kind === 'seabed') this.slideSpeed = Math.max(this.slideSpeed, vt - dvt);
        }
      } else if (kind === 'seabed') {
        _tmp2.copy(normal).multiplyScalar(vn);
        this.slideSpeed = Math.max(this.slideSpeed, _tmp.subVectors(vWorld, _tmp2).length());
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
      // Skid friction also brakes rotation (≈ 0.96 per step at 120 Hz).
      this.angularVelocity.multiplyScalar(Math.pow(0.96, dt * 120));
    }

    // Structures, then boulders / berm near the hull (spatial query: only a handful of candidates).
    const near = _near;
    near.length = 0;
    if (env.queryColliders) {
      const e = HULL_EXTENT + HULL_RADIUS;
      env.queryColliders(this.position.x - e, this.position.z - e, this.position.x + e, this.position.z + e, near);
    }
    for (const off of HULL_SPHERES) {
      const center = new Vector3(off, 0, 0).applyQuaternion(q).add(this.position);
      for (let k = 0, nk = env.colliders.length + near.length; k < nk; k++) {
        const col = k < env.colliders.length ? env.colliders[k] : near[k - env.colliders.length];
        const b = colliderBounds(col);
        const reach = b.r + HULL_RADIUS;
        if (Math.abs(center.x - b.x) > reach || Math.abs(center.z - b.z) > reach || Math.abs(center.y - b.y) > reach) continue;
        const contact = sphereCollider(center, HULL_RADIUS, col);
        if (contact) {
          // Rock (boulder / berm) contacts are seabed contacts: friction, sediment kick.
          applyContact(contact.normal, contact.depth, col.surface === 'rock' ? 'seabed' : 'structure');
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
  altitude(env: PhysicsEnvironment, maxRange: number = ALTIMETER.maxRange): number | null {
    // Transducer on the bottom of the frame, looking along the body's down axis
    // (it tilts with the vehicle) — single-beam altimeter model (sim/altimeter.ts).
    const bottom = _tmp.set(0, -this.params.size[1] / 2, 0).applyQuaternion(this.orientation).add(this.position);
    const axis = _tmp2.set(0, -1, 0).applyQuaternion(this.orientation).normalize();
    return altimeterReading(bottom, axis, env, { ...ALTIMETER, maxRange });
  }

}
