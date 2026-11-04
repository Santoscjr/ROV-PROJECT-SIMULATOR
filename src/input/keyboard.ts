import type { Bindable, KeyBindings } from '../config/settings';
import type { AxisCommand, InputDevice, PilotAction } from './types';

const AXIS_KEYS = ['surge', 'sway', 'heave', 'yaw', 'camTilt'] as const;
type KeyAxis = (typeof AXIS_KEYS)[number];

const ACTIONS: PilotAction[] = [
  'toggleLights',
  'lightsUp',
  'lightsDown',
  'toggleCamera',
  'camTiltCenter',
  'cycleMode',
  'modeManual',
  'modeStabilize',
  'modeDepthHold',
  'confirm',
  'pause',
  'help',
  'toggleHud',
];

export interface KeySource {
  addEventListener(type: 'keydown' | 'keyup', fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown' | 'keyup', fn: (e: KeyboardEvent) => void): void;
}

/**
 * Keyboard device. Uses `KeyboardEvent.code` (physical key position) so the
 * default bindings work on any layout (QWERTY, AZERTY, ABNT2…). Digital keys
 * are ramped to emulate a proportional joystick, which gives progressive
 * thrust instead of on/off steps.
 */
export class KeyboardDevice implements InputDevice {
  readonly id = 'keyboard';
  readonly label = 'Teclado';
  private readonly down = new Set<string>();
  private pending: PilotAction[] = [];
  private readonly values: Record<KeyAxis, number> = { surge: 0, sway: 0, heave: 0, yaw: 0, camTilt: 0 };
  private codeToBinding = new Map<string, Bindable[]>();
  private lastPoll = -1;
  /** Seconds to ramp from 0 to full command (0 = instantaneous). */
  ramp = 0.35;
  /** When false, key events are ignored (e.g. while typing in a form). */
  enabled = true;

  constructor(
    bindings: KeyBindings,
    private readonly source: KeySource = window,
    private readonly now: () => number = () => performance.now() / 1000,
  ) {
    this.setBindings(bindings);
    source.addEventListener('keydown', this.onDown);
    source.addEventListener('keyup', this.onUp);
    if (typeof window !== 'undefined' && source === window) window.addEventListener('blur', this.onBlur);
  }

  setBindings(b: KeyBindings): void {
    this.codeToBinding = new Map();
    (Object.keys(b) as Bindable[]).forEach((k) => {
      for (const code of b[k]) {
        const list = this.codeToBinding.get(code) ?? [];
        list.push(k);
        this.codeToBinding.set(code, list);
      }
    });
  }

  connected(): boolean {
    return true;
  }

  private isFormTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && typeof t.tagName === 'string' && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
  }

  private onDown = (e: KeyboardEvent) => {
    if (!this.enabled || this.isFormTarget(e)) return;
    const binds = this.codeToBinding.get(e.code);
    if (!binds) return;
    e.preventDefault();
    if (!e.repeat) {
      for (const b of binds) if ((ACTIONS as string[]).includes(b)) this.pending.push(b as PilotAction);
    }
    this.down.add(e.code);
  };

  private onUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => this.down.clear();

  /** True while any key bound to `b` is held. */
  held(b: Bindable): boolean {
    for (const [code, list] of this.codeToBinding) if (list.includes(b) && this.down.has(code)) return true;
    return false;
  }

  /** Axes currently requested by held keys (unramped), for HUD indication. */
  private target(axis: KeyAxis): number {
    return (this.held(`${axis}+` as Bindable) ? 1 : 0) - (this.held(`${axis}-` as Bindable) ? 1 : 0);
  }

  poll(): { axes: Partial<AxisCommand>; actions: PilotAction[] } {
    const t = this.now();
    const dt = this.lastPoll >= 0 ? Math.min(0.1, t - this.lastPoll) : 0;
    this.lastPoll = t;
    const step = this.ramp > 0 ? dt / this.ramp : 1;
    const axes: Partial<AxisCommand> = {};
    for (const a of AXIS_KEYS) {
      const target = this.target(a);
      const cur = this.values[a];
      // Release faster than engage (stick springs back to centre).
      const releasing = cur !== 0 && (target === 0 || Math.sign(target) !== Math.sign(cur));
      const rate = releasing ? step * 2 : step;
      const next = cur + Math.max(-rate, Math.min(rate, target - cur));
      this.values[a] = Math.abs(next) < 1e-3 ? 0 : next;
      if (this.values[a] !== 0) axes[a] = this.values[a];
    }
    const actions = this.pending;
    this.pending = [];
    return { axes, actions };
  }

  releaseAll(): void {
    this.down.clear();
    for (const a of AXIS_KEYS) this.values[a] = 0;
  }

  dispose(): void {
    this.source.removeEventListener('keydown', this.onDown);
    this.source.removeEventListener('keyup', this.onUp);
    if (typeof window !== 'undefined' && this.source === window) window.removeEventListener('blur', this.onBlur);
  }
}
