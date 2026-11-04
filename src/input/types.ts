/**
 * Pilot command vocabulary. Every input device produces a partial set of
 * these values; the InputManager merges them into a single PilotCommand that
 * the ROV controller consumes. Devices never talk to the physics directly.
 */

/** Continuous axes, normalised to [-1, 1]. */
export interface AxisCommand {
  /** + forward */
  surge: number;
  /** + starboard (right) */
  sway: number;
  /** + up */
  heave: number;
  /** + clockwise seen from above (turn right) */
  yaw: number;
  /** + nose up (only used when the vehicle exposes active pitch) */
  pitch: number;
  /** + starboard down */
  roll: number;
  /** camera tilt rate, + up */
  camTilt: number;
}

export type AxisName = keyof AxisCommand;

export const AXIS_NAMES: AxisName[] = ['surge', 'sway', 'heave', 'yaw', 'pitch', 'roll', 'camTilt'];

export function zeroAxes(): AxisCommand {
  return { surge: 0, sway: 0, heave: 0, yaw: 0, pitch: 0, roll: 0, camTilt: 0 };
}

/** Discrete one-shot actions (edge triggered). */
export type PilotAction =
  | 'toggleLights'
  | 'lightsUp'
  | 'lightsDown'
  | 'toggleCamera'
  | 'modeManual'
  | 'modeStabilize'
  | 'modeDepthHold'
  | 'cycleMode'
  | 'confirm'
  | 'pause'
  | 'help'
  | 'camTiltCenter'
  | 'fineControl';

/**
 * Contract for an input device. `poll` is called once per rendered frame and
 * returns the axes the device is currently commanding (absent axes = 0) and
 * the actions triggered since the previous poll.
 */
export interface InputDevice {
  readonly id: string;
  readonly label: string;
  connected(): boolean;
  poll(): { axes: Partial<AxisCommand>; actions: PilotAction[] };
  dispose?(): void;
}
