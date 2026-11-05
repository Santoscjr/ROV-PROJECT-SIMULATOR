import { Quaternion, Vector3 } from 'three';
import type { BoxCollider } from './site';

/**
 * Top-Hat TMS launch & recovery state machine (training approximation).
 *
 * The TMS hangs from the vessel's main umbilical; the ROV is latched under it
 * (latch bullet on the ROV top into the TMS receptacle). States:
 *   deck → lowering → atDepth (latched) ⇄ released → [docking capture] → atDepth → raising → onDeck
 * While latched the ROV is held kinematically under the TMS (no free motion);
 * it is only freed by an explicit release at depth, and only re-latched when
 * position, alignment and relative speed are inside the capture envelope.
 */

export type LarsState = 'deck' | 'lowering' | 'atDepth' | 'released' | 'raising' | 'onDeck';

/** Geometry (TMS local frame = ROV body frame when docked: +X forward, +Y up). */
export const TOPHAT = {
  /** Half extents of the TMS body (m). */
  half: { x: 1.3, y: 0.72, z: 0.85 },
  /** Receptacle mouth (bottom centre). */
  receptacle: new Vector3(0, -0.66, 0),
  /** Tether exit guide (aft, above the ROV's tether termination). */
  exit: new Vector3(-0.6, -0.72, 0),
  /** Main umbilical termination on top. */
  lift: new Vector3(0, 1.45, 0),
  /** ROV CG below the TMS centre when latched. */
  dockDrop: 1.43,
  /** Top of the ROV latch bullet in the ROV body frame. */
  bulletTop: new Vector3(0, 0.96, 0),
};

export interface CaptureCheck {
  horizontal: number;
  vertical: number;
  headingError: number;
  relSpeed: number;
  payout: number;
  ok: boolean;
}

export interface CaptureEnvelope {
  horizontal: number;
  vertical: number;
  heading: number;
  speed: number;
  payout: number;
}

export const CAPTURE_STRICT: CaptureEnvelope = { horizontal: 0.35, vertical: 0.4, heading: 8, speed: 0.25, payout: 8 };
export const CAPTURE_ASSIST: CaptureEnvelope = { horizontal: 0.9, vertical: 1.1, heading: 20, speed: 0.4, payout: 12 };

const _v = new Vector3();
const _q = new Quaternion();
const UP = new Vector3(0, 1, 0);

export class TopHat {
  state: LarsState = 'deck';
  /** TMS centre (world). */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  /** Heading of the assembly about +Y (rad); π/2 = facing north. */
  yaw = Math.PI / 2;
  /** Operating (release) depth of the TMS centre (m, positive). */
  depth = 80;
  /** Main umbilical winch speed (m/s). */
  winchSpeed = 0.9;
  assist = true;
  /** Horizontal excursion of the hanging TMS (current + tether pull), m. */
  readonly sway = new Vector3();
  readonly collider: BoxCollider;
  lastCapture: CaptureCheck | null = null;
  /** Capture is armed only after the ROV has cleared the TMS following a release. */
  captureArmed = false;

  constructor(
    private readonly hangX: number,
    private readonly hangZ: number,
    private readonly deckHeight: number,
  ) {
    this.collider = { kind: 'box', center: { x: 0, y: 0, z: 0 }, half: { ...TOPHAT.half }, yaw: this.yaw };
  }

  get latched(): boolean {
    return this.state !== 'released';
  }

  get envelope(): CaptureEnvelope {
    return this.assist ? CAPTURE_ASSIST : CAPTURE_STRICT;
  }

  /** Assembly on deck (inspection) or already positioned at depth (subsea-start operations). */
  reset(start: 'deck' | 'atDepth', depth = this.depth): void {
    this.depth = depth;
    this.state = start;
    this.sway.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.position.set(this.hangX, start === 'deck' ? this.deckHeight : -depth, this.hangZ);
    this.lastCapture = null;
    this.syncCollider();
  }

  startLowering(): boolean {
    if (this.state !== 'deck') return false;
    this.state = 'lowering';
    return true;
  }

  release(): boolean {
    if (this.state !== 'atDepth') return false;
    this.state = 'released';
    this.captureArmed = false;
    return true;
  }

  startRaise(): boolean {
    if (this.state !== 'atDepth') return false;
    this.state = 'raising';
    return true;
  }

  private local(v: Vector3, out: Vector3): Vector3 {
    return out.copy(v).applyQuaternion(_q.setFromAxisAngle(UP, this.yaw)).add(this.position);
  }
  exitWorld(out = new Vector3()): Vector3 {
    return this.local(TOPHAT.exit, out);
  }
  receptacleWorld(out = new Vector3()): Vector3 {
    return this.local(TOPHAT.receptacle, out);
  }
  liftWorld(out = new Vector3()): Vector3 {
    return this.local(TOPHAT.lift, out);
  }
  /** ROV CG pose when latched. */
  dockPosition(out = new Vector3()): Vector3 {
    return out.copy(this.position).add(_v.set(0, -TOPHAT.dockDrop, 0));
  }

  /**
   * @param current water velocity at the TMS (world)
   * @param tetherPull force of the tether on the TMS (world, N)
   */
  update(dt: number, current: Vector3, tetherPull: Vector3): void {
    const prev = _v.copy(this.position);
    const prevX = prev.x;
    const prevY = prev.y;
    const prevZ = prev.z;
    switch (this.state) {
      case 'lowering':
        this.position.y = Math.max(-this.depth, this.position.y - this.winchSpeed * dt);
        if (this.position.y <= -this.depth + 1e-6) this.state = 'atDepth';
        break;
      case 'raising':
        this.position.y = Math.min(this.deckHeight, this.position.y + this.winchSpeed * dt);
        if (this.position.y >= this.deckHeight - 1e-6) this.state = 'onDeck';
        break;
      default:
        break;
    }
    // Pendulum-like excursion of the submerged TMS (first order, bounded):
    // drag of the current on the TMS + main umbilical, plus the tether pull.
    const submerged = this.position.y < -3;
    const tx = submerged ? Math.max(-3, Math.min(3, current.x * 5 + tetherPull.x / 2500)) : 0;
    const tz = submerged ? Math.max(-3, Math.min(3, current.z * 5 + tetherPull.z / 2500)) : 0;
    const k = 1 - Math.exp(-dt / 8);
    this.sway.x += (tx - this.sway.x) * k;
    this.sway.z += (tz - this.sway.z) * k;
    this.position.x = this.hangX + this.sway.x;
    this.position.z = this.hangZ + this.sway.z;
    this.velocity.set((this.position.x - prevX) / dt, (this.position.y - prevY) / dt, (this.position.z - prevZ) / dt);
    this.syncCollider();
  }

  private syncCollider(): void {
    this.collider.center.x = this.position.x;
    this.collider.center.y = this.position.y;
    this.collider.center.z = this.position.z;
    this.collider.yaw = this.yaw;
  }

  /** Evaluate the docking capture envelope for the ROV (does not change state). */
  checkCapture(rovPos: Vector3, rovQuat: Quaternion, rovVel: Vector3, rovHeadingDeg: number, payout: number): CaptureCheck {
    const tip = _v.copy(TOPHAT.bulletTop).applyQuaternion(rovQuat).add(rovPos);
    const rec = this.receptacleWorld(new Vector3());
    const horizontal = Math.hypot(tip.x - rec.x, tip.z - rec.z);
    const vertical = Math.abs(rec.y - tip.y);
    const tmsHeading = ((90 - (this.yaw * 180) / Math.PI) % 360 + 360) % 360;
    let he = (rovHeadingDeg - tmsHeading) % 360;
    if (he > 180) he -= 360;
    if (he < -180) he += 360;
    if (Math.hypot(tip.x - rec.x, tip.y - rec.y, tip.z - rec.z) > 2) this.captureArmed = true;
    const relSpeed = Math.hypot(rovVel.x - this.velocity.x, rovVel.y - this.velocity.y, rovVel.z - this.velocity.z);
    const e = this.envelope;
    const ok = this.captureArmed && horizontal <= e.horizontal && vertical <= e.vertical && Math.abs(he) <= e.heading && relSpeed <= e.speed && payout <= e.payout;
    this.lastCapture = { horizontal, vertical, headingError: he, relSpeed, payout, ok };
    return this.lastCapture;
  }

  /** Latch the ROV (call when checkCapture().ok while released). */
  latch(): boolean {
    if (this.state !== 'released') return false;
    this.state = 'atDepth';
    return true;
  }
}
