import type { CurrentLevel } from '../sim/ocean';
import type { PilotMode } from '../control/rovController';

export type GraphicsQuality = 'low' | 'medium' | 'high';

/** Logical bindable controls. Axis controls come in +/− pairs. */
export const BINDABLE = [
  'surge+',
  'surge-',
  'sway+',
  'sway-',
  'heave+',
  'heave-',
  'yaw+',
  'yaw-',
  'camTilt+',
  'camTilt-',
  'fineControl',
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
] as const;
export type Bindable = (typeof BINDABLE)[number];
export type KeyBindings = Record<Bindable, string[]>;

export type KeyboardPreset = 'wasd' | 'arrows';

const COMMON: Omit<KeyBindings, 'surge+' | 'surge-' | 'sway+' | 'sway-' | 'heave+' | 'heave-' | 'yaw+' | 'yaw-'> = {
  'camTilt+': ['KeyT'],
  'camTilt-': ['KeyG'],
  fineControl: ['ShiftLeft', 'ShiftRight'],
  toggleLights: ['KeyL'],
  lightsUp: ['BracketRight', 'Equal'],
  lightsDown: ['BracketLeft', 'Minus'],
  toggleCamera: ['KeyC'],
  camTiltCenter: ['KeyV'],
  cycleMode: ['KeyM'],
  modeManual: ['Digit1'],
  modeStabilize: ['Digit2'],
  modeDepthHold: ['Digit3'],
  confirm: ['Enter', 'NumpadEnter'],
  pause: ['Escape', 'KeyP'],
  help: ['KeyH', 'F1'],
};

export const KEYBOARD_PRESETS: Record<KeyboardPreset, KeyBindings> = {
  wasd: {
    ...COMMON,
    'surge+': ['KeyW'],
    'surge-': ['KeyS'],
    'sway+': ['KeyD'],
    'sway-': ['KeyA'],
    'heave+': ['KeyR'],
    'heave-': ['KeyF'],
    'yaw+': ['KeyE'],
    'yaw-': ['KeyQ'],
  },
  arrows: {
    ...COMMON,
    'surge+': ['ArrowUp'],
    'surge-': ['ArrowDown'],
    'sway+': ['Period', 'Numpad6'],
    'sway-': ['Comma', 'Numpad4'],
    'heave+': ['PageUp', 'Numpad8'],
    'heave-': ['PageDown', 'Numpad2'],
    'yaw+': ['ArrowRight'],
    'yaw-': ['ArrowLeft'],
  },
};

export interface Settings {
  graphics: GraphicsQuality;
  /** Global pilot gain applied to translation/yaw commands (0.2–1). */
  sensitivity: number;
  /** Keyboard ramp time to full command (s). */
  keyRamp: number;
  mouseSensitivity: number;
  invert: { surge: boolean; sway: boolean; heave: boolean; yaw: boolean; camTilt: boolean };
  gamepadDeadzone: number;
  keyboardPreset: KeyboardPreset;
  bindings: KeyBindings;
  defaultMode: PilotMode;
  current: CurrentLevel;
  volume: number;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  graphics: 'medium',
  sensitivity: 0.8,
  keyRamp: 0.35,
  mouseSensitivity: 1,
  invert: { surge: false, sway: false, heave: false, yaw: false, camTilt: false },
  gamepadDeadzone: 0.12,
  keyboardPreset: 'wasd',
  bindings: structuredClone(KEYBOARD_PRESETS.wasd),
  defaultMode: 'stabilize',
  current: 'normal',
  volume: 0.7,
  showFps: false,
};

const STORAGE_KEY = 'rov.settings.v1';
const QUALITIES: GraphicsQuality[] = ['low', 'medium', 'high'];
const MODES: PilotMode[] = ['manual', 'stabilize', 'depthHold'];
const CURRENTS: CurrentLevel[] = ['off', 'low', 'normal', 'strong'];

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const pick = <T>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);

/** Validate an untrusted object (e.g. from localStorage) into complete settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const inv = (r.invert && typeof r.invert === 'object' ? r.invert : {}) as Record<string, unknown>;
  const preset = pick(r.keyboardPreset, ['wasd', 'arrows'] as const, d.keyboardPreset);
  const base = KEYBOARD_PRESETS[preset];
  const rb = (r.bindings && typeof r.bindings === 'object' ? r.bindings : {}) as Record<string, unknown>;
  const bindings = {} as KeyBindings;
  for (const k of BINDABLE) {
    const v = rb[k];
    bindings[k] = Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).slice(0, 3) : [...base[k]];
  }
  return {
    graphics: pick(r.graphics, QUALITIES, d.graphics),
    sensitivity: num(r.sensitivity, 0.2, 1, d.sensitivity),
    keyRamp: num(r.keyRamp, 0, 1.5, d.keyRamp),
    mouseSensitivity: num(r.mouseSensitivity, 0.2, 3, d.mouseSensitivity),
    invert: {
      surge: inv.surge === true,
      sway: inv.sway === true,
      heave: inv.heave === true,
      yaw: inv.yaw === true,
      camTilt: inv.camTilt === true,
    },
    gamepadDeadzone: num(r.gamepadDeadzone, 0, 0.5, d.gamepadDeadzone),
    keyboardPreset: preset,
    bindings,
    defaultMode: pick(r.defaultMode, MODES, d.defaultMode),
    current: pick(r.current, CURRENTS, d.current),
    volume: num(r.volume, 0, 1, d.volume),
    showFps: r.showFps === true,
  };
}

type Listener = (s: Settings) => void;

/** Persistent settings store (localStorage when available). */
export class SettingsStore {
  private value: Settings;
  private listeners = new Set<Listener>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    let raw: unknown = null;
    try {
      const txt = this.storage?.getItem(STORAGE_KEY);
      raw = txt ? JSON.parse(txt) : null;
    } catch {
      raw = null;
    }
    this.value = sanitizeSettings(raw);
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): void {
    this.value = sanitizeSettings({ ...this.value, ...patch });
    this.persist();
    this.listeners.forEach((l) => l(this.value));
  }

  reset(): void {
    this.value = structuredClone(DEFAULT_SETTINGS);
    this.persist();
    this.listeners.forEach((l) => l(this.value));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      /* storage unavailable (private mode) — keep in memory */
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
