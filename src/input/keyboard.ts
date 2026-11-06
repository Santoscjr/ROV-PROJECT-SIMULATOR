import type { Bindable, KeyBindings } from '../config/settings';
import type { AxisCommand, InputDevice, PilotAction } from './types';

const AXIS_KEYS = ['surge', 'sway', 'heave', 'yaw', 'pitch', 'camTilt'] as const;
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
  'tetherStop',
  'tmsAuto',
  'camOp',
  'camAux',
  'camExt',
  'camTms',
  'camTether',
  'layoutCycle',
  'monitorOpen',
  'tmsRecover',
  'toggleGuide',
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
  private readonly values: Record<KeyAxis, number> = { surge: 0, sway: 0, heave: 0, yaw: 0, pitch: 0, camTilt: 0 };
  private codeToBinding = new Map<string, Bindable[]>();
  private lastPoll = -1;
  /** Seconds to ramp from 0 to full command (0 = instantaneous). */
  ramp = 0.35;
  /** When false, key events are ignored (e.g. while typing in a form). */
  enabled = true;
  /**
   * True while a menu/settings screen is open. Then form controls (selects,
   * sliders, checkboxes, buttons) keep their native keyboard behaviour.
   * While piloting (no menu), a key bound to a command always goes to the
   * simulation: the browser default is prevented and the control loses focus,
   * so e.g. ↑/↓ can never change a camera selector by accident.
   */
  uiActive: () => boolean = () => false;
  private readonly extraSources: Window[] = [];

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

  /** Text entry: always keeps the keyboard (the user is typing). */
  static isTextEditing(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return ['text', 'number', 'search', 'email', 'password', 'url', 'tel'].includes(type);
  }

  /** Other focusable controls (select, slider, checkbox, button). */
  static isFormControl(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && typeof el.tagName === 'string' && /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(el.tagName);
  }

  /** Should this key event be handled as a pilot command? (pure policy, testable) */
  static routeToPilot(target: EventTarget | null, uiActive: boolean): boolean {
    if (KeyboardDevice.isTextEditing(target)) return false;
    if (KeyboardDevice.isFormControl(target) && uiActive) return false;
    return true;
  }

  /** Also listen to another window (secondary monitor). Events of one window are never duplicated. */
  attachWindow(win: Window): void {
    if (this.extraSources.includes(win)) return;
    this.extraSources.push(win);
    win.addEventListener('keydown', this.onDown);
    win.addEventListener('keyup', this.onUp);
    win.addEventListener('blur', this.onBlur);
  }

  detachWindow(win: Window): void {
    const i = this.extraSources.indexOf(win);
    if (i < 0) return;
    this.extraSources.splice(i, 1);
    try {
      win.removeEventListener('keydown', this.onDown);
      win.removeEventListener('keyup', this.onUp);
      win.removeEventListener('blur', this.onBlur);
    } catch {
      /* window already gone */
    }
  }

  private onDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    const binds = this.codeToBinding.get(e.code);
    if (!binds) return;
    if (!KeyboardDevice.routeToPilot(e.target, this.uiActive())) return;
    e.preventDefault();
    // A focused selector/button must not keep the keyboard during piloting.
    if (KeyboardDevice.isFormControl(e.target)) (e.target as HTMLElement).blur?.();
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
