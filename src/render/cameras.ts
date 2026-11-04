import { MathUtils, PerspectiveCamera, Quaternion, Vector3, type Object3D } from 'three';
import { terrainHeight } from '../sim/terrain';

export type CameraMode = 'operational' | 'external';

const _v = new Vector3();
const _q = new Quaternion();

/**
 * Camera rig. The operational camera rides on the ROV pan/tilt unit; the
 * external camera orbits the vehicle and follows its heading. Mouse input
 * only ever drives the camera — never the vehicle.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'external';
  /** Pan/tilt unit tilt angle (deg), + up. */
  tilt = -10;
  readonly tiltRange = { min: -70, max: 30 };
  // External orbit, relative to the vehicle heading.
  orbitYaw = MathUtils.degToRad(150);
  orbitPitch = MathUtils.degToRad(12);
  orbitDist = 7.5;
  private readonly smoothPos = new Vector3();
  private initialised = false;
  mouseSensitivity = 1;
  invertTilt = false;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(60, aspect, 0.08, 1600);
  }

  toggle(): CameraMode {
    this.mode = this.mode === 'operational' ? 'external' : 'operational';
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
    } else {
      this.adjustTilt(-dy * k * 30 * (this.invertTilt ? -1 : 1));
    }
  }

  wheel(delta: number): void {
    if (this.mode === 'external') this.orbitDist = MathUtils.clamp(this.orbitDist * (1 + Math.sign(delta) * 0.1), 3.5, 40);
    else this.adjustTilt(-Math.sign(delta) * 3);
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
      cam.fov = 64;
      eye.getWorldPosition(cam.position);
      eye.getWorldQuaternion(_q);
      // eye looks along its local +X; camera looks along -Z → rotate.
      cam.quaternion.copy(_q).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2));
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
