import { AXIS_NAMES, zeroAxes, type AxisCommand, type AxisName, type InputDevice, type PilotAction } from './types';

export interface InputShaping {
  /** Global gain on surge/sway/heave/yaw (0.2–1). */
  sensitivity: number;
  invert: Partial<Record<AxisName, boolean>>;
  /** Gain applied while "fine control" is active. */
  fineGain: number;
}

/**
 * Merges every registered device into a single PilotCommand.
 * Devices → InputManager → PilotCommand → RovController → Physics.
 * Adding a device never requires touching the controller or the physics.
 */
export class InputManager {
  private readonly devices: InputDevice[] = [];
  readonly command: AxisCommand = zeroAxes();
  /** Raw (pre-shaping) merged axes, for the HUD "active commands" display. */
  readonly raw: AxisCommand = zeroAxes();
  /** Which device contributed to each axis in the last poll. */
  readonly sources: Partial<Record<AxisName, string>> = {};
  fine = false;
  shaping: InputShaping = { sensitivity: 0.8, invert: {}, fineGain: 0.35 };

  add(device: InputDevice): void {
    if (!this.devices.includes(device)) this.devices.push(device);
  }

  remove(device: InputDevice): void {
    const i = this.devices.indexOf(device);
    if (i >= 0) this.devices.splice(i, 1);
  }

  list(): readonly InputDevice[] {
    return this.devices;
  }

  /** Poll all devices; returns the actions triggered since the last poll. */
  poll(): PilotAction[] {
    const actions: PilotAction[] = [];
    const merged = zeroAxes();
    for (const k of AXIS_NAMES) delete this.sources[k];
    for (const d of this.devices) {
      if (!d.connected()) continue;
      const r = d.poll();
      actions.push(...r.actions);
      for (const k of AXIS_NAMES) {
        const v = r.axes[k];
        if (v !== undefined && v !== 0) {
          merged[k] += v;
          this.sources[k] = d.id;
        }
      }
    }
    const s = this.shaping;
    for (const k of AXIS_NAMES) {
      let v = Math.max(-1, Math.min(1, merged[k]));
      this.raw[k] = v;
      if (s.invert[k]) v = -v;
      if (k !== 'camTilt') v *= s.sensitivity * (this.fine ? s.fineGain : 1);
      this.command[k] = v;
    }
    return actions;
  }

  /** Zero the command (e.g. when paused). */
  clear(): void {
    Object.assign(this.command, zeroAxes());
    Object.assign(this.raw, zeroAxes());
  }
}
