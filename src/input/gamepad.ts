import type { AxisCommand, InputDevice, PilotAction } from './types';

/** Apply a radial-ish dead zone and rescale so output still reaches ±1. */
export function applyDeadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return (Math.sign(v) * (a - dz)) / (1 - dz);
}

/**
 * Gamepad API device (standard mapping). Default layout follows the common
 * ArduSub convention: left stick = heave/yaw, right stick = surge/sway.
 */
export class GamepadDevice implements InputDevice {
  readonly id = 'gamepad';
  label = 'Gamepad';
  deadzone = 0.12;
  private prevButtons: boolean[] = [];
  private index: number | null = null;

  private static readonly BUTTON_ACTIONS: Partial<Record<number, PilotAction>> = {
    0: 'confirm',
    1: 'toggleCamera',
    2: 'cycleMode',
    3: 'toggleLights',
    4: 'lightsDown',
    5: 'lightsUp',
    8: 'help',
    9: 'pause',
    10: 'camTiltCenter',
  };

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.index !== null && pads[this.index]?.connected) return pads[this.index];
    for (const p of pads) {
      // Ignore multi-axis devices without a standard mapping (handled elsewhere).
      if (p && p.connected && p.mapping === 'standard') {
        this.index = p.index;
        this.label = p.id;
        return p;
      }
    }
    this.index = null;
    return null;
  }

  connected(): boolean {
    return this.pad() !== null;
  }

  poll(): { axes: Partial<AxisCommand>; actions: PilotAction[] } {
    const p = this.pad();
    if (!p) return { axes: {}, actions: [] };
    const dz = this.deadzone;
    const ax = (i: number) => applyDeadzone(p.axes[i] ?? 0, dz);
    const btn = (i: number) => !!p.buttons[i]?.pressed;
    const axes: Partial<AxisCommand> = {
      heave: -ax(1),
      yaw: ax(0),
      surge: -ax(3),
      sway: ax(2),
      camTilt: (btn(12) ? 1 : 0) - (btn(13) ? 1 : 0),
    };
    // Triggers as fine heave alternative.
    const lt = p.buttons[6]?.value ?? 0;
    const rt = p.buttons[7]?.value ?? 0;
    if (lt > 0.05 || rt > 0.05) axes.heave = (axes.heave ?? 0) + rt - lt;
    const actions: PilotAction[] = [];
    p.buttons.forEach((b, i) => {
      const was = this.prevButtons[i] ?? false;
      if (b.pressed && !was) {
        const a = GamepadDevice.BUTTON_ACTIONS[i];
        if (a) actions.push(a);
      }
      this.prevButtons[i] = b.pressed;
    });
    return { axes, actions };
  }
}
