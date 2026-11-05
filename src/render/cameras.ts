import { MathUtils, PerspectiveCamera, Quaternion, Vector3, type Object3D } from 'three';
import { terrainHeight } from '../sim/terrain';
import { DEFAULT_CAM_STATES, type CameraStates } from '../config/settings';

/** ROV pilot camera, external observer, TMS monitoring camera, ROV top (tether) camera. */
export type CameraMode = 'operational' | 'auxiliary' | 'external' | 'tms' | 'tether';
export const CAMERA_MODES: CameraMode[] = ['operational', 'auxiliary', 'external', 'tms', 'tether'];

const _v = new Vector3();
const _q = new Quaternion();
/** Tether camera position in the ROV body frame (top, forward of the termination). */
const TETHER_CAM_OFFSET = new Vector3(0.55, 1.02, 0.35);
/** Auxiliary camera in the ROV body frame (lower starboard bow, clear of the arms). */
const AUX_CAM_OFFSET = new Vector3(1.28, -0.42, 0.62);

/**
 * Camera rig. The operational camera rides on the ROV pan/tilt unit; the
 * external camera orbits the vehicle and follows its heading. Mouse input
 * only ever drives the camera — never the vehicle.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'external';
  /**
   * Orientation of the physical cameras (operational, auxiliary, tether).
   * Shared by every rig/panel that shows the same camera — a physical camera
   * has one pan/tilt state — and persisted in Settings.camState.
   */
  states: CameraStates;
  /** Pan/tilt unit tilt angle of the operational camera (deg), + up. */
  get tilt(): number {
    return this.states.operational.tilt;
  }
  set tilt(v: number) {
    this.states.operational.tilt = v;
  }
  /** Operational camera pan (deg, + right) and zoom factor (1 = wide, 0.35 = tele). */
  get pan(): number {
    return this.states.operational.pan;
  }
  set pan(v: number) {
    this.states.operational.pan = v;
  }
  get zoom(): number {
    return this.states.operational.zoom;
  }
  set zoom(v: number) {
    this.states.operational.zoom = v;
  }
  get auxPan(): number {
    return this.states.auxiliary.pan;
  }
  set auxPan(v: number) {
    this.states.auxiliary.pan = v;
  }
  get auxTilt(): number {
    return this.states.auxiliary.tilt;
  }
  set auxTilt(v: number) {
    this.states.auxiliary.tilt = v;
  }
  get tetherPan(): number {
    return this.states.tether.pan;
  }
  set tetherPan(v: number) {
    this.states.tether.pan = v;
  }
  get tetherTilt(): number {
    return this.states.tether.tilt;
  }
  set tetherTilt(v: number) {
    this.states.tether.tilt = v;
  }
  readonly tiltRange = { min: -70, max: 30 };
  // External orbit, relative to the vehicle heading.
  orbitYaw = MathUtils.degToRad(150);
  orbitPitch = MathUtils.degToRad(12);
  orbitDist = 7.5;
  private readonly smoothPos = new Vector3();
  private initialised = false;
  mouseSensitivity = 1;
  invertTilt = false;
  /** TMS monitoring camera mount (local −Z = view), set by the app. */
  tmsMount: Object3D | null = null;

  constructor(aspect: number, states: CameraStates = structuredClone(DEFAULT_CAM_STATES)) {
    this.states = states;
    this.camera = new PerspectiveCamera(60, aspect, 0.08, 1600);
  }

  toggle(): CameraMode {
    this.mode = this.mode === 'operational' ? 'external' : 'operational';
    this.initialised = false;
    return this.mode;
  }

  /** Cycle through all camera sources. */
  cycle(): CameraMode {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.initialised = false;
    return this.mode;
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    this.initialised = false;
  }

  /** Mouse drag in pixels. */
  drag(dx: number, dy: number): void {
    const k = 0.005 * this.mouseSensitivity;
    if (this.mode === 'external') {
      this.orbitYaw -= dx * k;
      this.orbitPitch = MathUtils.clamp(this.orbitPitch + dy * k, MathUtils.degToRad(-60), MathUtils.degToRad(80));
    } else if (this.mode === 'operational') {
      this.adjustTilt(-dy * k * 30 * (this.invertTilt ? -1 : 1));
      this.pan = MathUtils.clamp(this.pan + dx * k * 30, -60, 60);
    } else if (this.mode === 'auxiliary') {
      this.auxPan = MathUtils.clamp(this.auxPan + dx * k * 30, -40, 40);
      this.auxTilt = MathUtils.clamp(this.auxTilt - dy * k * 30, -40, 30);
    } else if (this.mode === 'tether') {
      this.tetherPan = MathUtils.clamp(this.tetherPan - dx * k * 30, -150, 150);
      this.tetherTilt = MathUtils.clamp(this.tetherTilt - dy * k * 30, -30, 60);
    }
  }

  /** Zoom of the current camera (+ = in): operational/auxiliary lens, external orbit distance. */
  adjustZoom(steps: number): void {
    if (this.mode === 'auxiliary') this.states.auxiliary.zoom = MathUtils.clamp(this.states.auxiliary.zoom * Math.pow(0.9, steps), 0.35, 1);
    else if (this.mode === 'external') this.orbitDist = MathUtils.clamp(this.orbitDist * Math.pow(0.95, steps), 3.5, 40);
    else this.zoom = MathUtils.clamp(this.zoom * Math.pow(0.9, steps), 0.35, 1);
  }

  /** Mouse wheel: tilt of the pilot/auxiliary camera (as in v2); with zoomModifier → zoom. */
  wheel(delta: number, zoomModifier = false): void {
    if (this.mode === 'external') this.orbitDist = MathUtils.clamp(this.orbitDist * (1 + Math.sign(delta) * 0.1), 3.5, 40);
    else if (zoomModifier) this.adjustZoom(-Math.sign(delta));
    else this.tiltBy(-Math.sign(delta) * 3);
  }

  /** Pan the current camera (deg, + right) — keyboard/device command. */
  panBy(deg: number): void {
    if (this.mode === 'operational') this.pan = MathUtils.clamp(this.pan + deg, -60, 60);
    else if (this.mode === 'auxiliary') this.auxPan = MathUtils.clamp(this.auxPan + deg, -40, 40);
    else if (this.mode === 'tether') this.tetherPan = MathUtils.clamp(this.tetherPan - deg, -150, 150);
    else if (this.mode === 'external') this.orbitYaw -= MathUtils.degToRad(deg);
  }

  /** Tilt the current camera (deg, + up) — keyboard/device command. Not the vehicle pitch. */
  tiltBy(deg: number): void {
    if (this.mode === 'operational') this.adjustTilt(deg);
    else if (this.mode === 'auxiliary') this.auxTilt = MathUtils.clamp(this.auxTilt + deg, -40, 30);
    else if (this.mode === 'tether') this.tetherTilt = MathUtils.clamp(this.tetherTilt + deg, -30, 60);
    else if (this.mode === 'external')
      this.orbitPitch = MathUtils.clamp(this.orbitPitch - MathUtils.degToRad(deg), MathUtils.degToRad(-60), MathUtils.degToRad(80));
  }

  adjustTilt(deg: number): void {
    this.tilt = MathUtils.clamp(this.tilt + deg, this.tiltRange.min, this.tiltRange.max);
  }

  /**
   * @param rovRoot vehicle root object (world transform up to date)
   * @param eye operational camera eye (child of the tilt unit)
   */
  update(dt: number, rovRoot: Object3D, eye: Object3D, rovHeadingRad: number): void {
    const cam = this.camera;
    if (this.mode === 'operational') {
      cam.fov = 64 * this.zoom;
      eye.getWorldPosition(cam.position);
      eye.getWorldQuaternion(_q);
      // eye looks along its local +X; camera looks along -Z → rotate; pan about the eye's up axis.
      cam.quaternion
        .copy(_q)
        .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2 - MathUtils.degToRad(this.pan)));
    } else if (this.mode === 'auxiliary') {
      // Auxiliary camera: lower starboard bow, wide angle, looking forward-down
      // (complements the pilot camera for close approaches and the work area).
      cam.fov = 82 * this.states.auxiliary.zoom;
      cam.position.copy(AUX_CAM_OFFSET).applyMatrix4(rovRoot.matrixWorld);
      rovRoot.getWorldQuaternion(_q);
      const yaw = MathUtils.degToRad(-8 + this.auxPan);
      const pitch = MathUtils.degToRad(-28 + this.auxTilt);
      const dir = new Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)).applyQuaternion(_q);
      cam.up.set(0, 1, 0).applyQuaternion(_q);
      cam.lookAt(_v.copy(cam.position).add(dir));
    } else if (this.mode === 'tms' && this.tmsMount) {
      cam.fov = 84;
      this.tmsMount.getWorldPosition(cam.position);
      this.tmsMount.getWorldQuaternion(cam.quaternion);
    } else if (this.mode === 'tether') {
      // Camera on top of the frame, forward of the termination, looking aft/up along the tether.
      cam.fov = 80;
      cam.position.copy(TETHER_CAM_OFFSET).applyMatrix4(rovRoot.matrixWorld);
      const yaw = MathUtils.degToRad(180 + this.tetherPan);
      const pitch = MathUtils.degToRad(22 + this.tetherTilt);
      const dir = new Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
      rovRoot.getWorldQuaternion(_q);
      dir.applyQuaternion(_q);
      cam.up.set(0, 1, 0).applyQuaternion(_q);
      cam.lookAt(_v.copy(cam.position).add(dir));
    } else {
      cam.fov = 55;
      const target = rovRoot.getWorldPosition(_v).clone();
      const yaw = this.orbitYaw + rovHeadingRad;
      const offset = new Vector3(
        Math.sin(yaw) * Math.cos(this.orbitPitch),
        Math.sin(this.orbitPitch),
        -Math.cos(yaw) * Math.cos(this.orbitPitch),
      ).multiplyScalar(this.orbitDist);
      const desired = target.clone().add(offset);
      const floor = terrainHeight(desired.x, desired.z) + 0.6;
      if (desired.y < floor) desired.y = floor;
      if (!this.initialised) {
        this.smoothPos.copy(desired);
        this.initialised = true;
      } else {
        this.smoothPos.lerp(desired, 1 - Math.exp(-dt * 6));
      }
      cam.position.copy(this.smoothPos);
      cam.up.set(0, 1, 0);
      cam.lookAt(target.add(new Vector3(0, 0.3, 0)));
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** World view direction of the operational camera (even when viewing externally). */
  operationalDirection(eye: Object3D, out = new Vector3()): Vector3 {
    eye.getWorldQuaternion(_q);
    return out.set(1, 0, 0).applyQuaternion(_q);
  }
}
