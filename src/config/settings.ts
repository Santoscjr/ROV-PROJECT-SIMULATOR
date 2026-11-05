import type { CurrentLevel, LightLevel, SeaState, VisibilityLevel } from '../sim/conditions';
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
  'camPan-',
  'camPan+',
  'pitch+',
  'pitch-',
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
  'toggleHud',
  'tetherPay',
  'tetherHaul',
  'tetherStop',
  'tmsAuto',
  'camOp',
  'camAux',
  'camExt',
  'camTms',
  'camTether',
  'zoomIn',
  'zoomOut',
  'tmsRecover',
  'layoutCycle',
  'monitorOpen',
] as const;
export type Bindable = (typeof BINDABLE)[number];
export type KeyBindings = Record<Bindable, string[]>;

export type KeyboardPreset = 'wasd' | 'arrows';

type PresetKeys = 'surge+' | 'surge-' | 'sway+' | 'sway-' | 'heave+' | 'heave-' | 'yaw+' | 'yaw-' | 'pitch+' | 'pitch-' | 'tetherPay' | 'tetherHaul';
const COMMON: Omit<KeyBindings, PresetKeys> = {
  'camTilt+': ['KeyT'],
  'camTilt-': ['KeyG'],
  'camPan-': ['KeyB'],
  'camPan+': ['KeyN'],
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
  toggleHud: ['KeyU'],
  tetherStop: ['KeyK'],
  tmsAuto: ['KeyJ'],
  camOp: ['Digit7'],
  camAux: ['Digit6'],
  camExt: ['Digit8'],
  camTms: ['Digit9'],
  camTether: ['Digit0'],
  zoomIn: ['KeyZ'],
  zoomOut: ['KeyX'],
  tmsRecover: ['KeyO'],
  layoutCycle: ['KeyY'],
  monitorOpen: ['F8'],
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
    'pitch+': ['PageUp'],
    'pitch-': ['PageDown'],
    tetherPay: ['ArrowUp'],
    tetherHaul: ['ArrowDown'],
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
    'pitch+': ['Home'],
    'pitch-': ['End'],
    tetherPay: ['Numpad9'],
    tetherHaul: ['Numpad3'],
  },
};

export interface CameraFx {
  /** Barrel distortion of the wide-angle subsea lens, 0–1. */
  distortion: number;
  /** Sensor noise, 0–1. */
  noise: number;
  /** Vignetting, 0–1. */
  vignette: number;
  /** Automatic exposure (camera gain follows scene brightness). */
  autoExposure: boolean;
  /** Exposure bias in EV, −1.5 … +1.5. */
  exposureBias: number;
  /** Contrast, 0.8 … 1.3. */
  contrast: number;
}

export const DEFAULT_CAMERA_FX: CameraFx = { distortion: 0.35, noise: 0.4, vignette: 0.5, autoExposure: true, exposureBias: 0, contrast: 1.05 };

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
  visibility: VisibilityLevel;
  light: LightLevel;
  sea: SeaState;
  /** Operational-camera image processing (all subtle by default). */
  cameraFx: CameraFx;
  volume: number;
  showFps: boolean;
  /** Contextual tips for beginners in the mission panel. */
  showHints: boolean;
  /** Last selected operation. */
  mission: 'training' | 'inspection' | 'adverse' | 'tms' | 'free';
  /** Pilot station layout and the source shown in each panel. */
  layout: ViewLayout;
  panels: ViewSource[];
  /** Tether wet weight preset. */
  tetherBuoyancy: 'positive' | 'neutral' | 'negative';
  /** Source shown on the secondary monitor window. */
  /** @deprecated v3.1 single-source monitor (migrated into `monitor.sources[0]`). */
  monitorSource: ViewSource;
  /** Panel source lock: a locked panel never changes source from shortcuts/devices. */
  panelLocks: boolean[];
  /** Orientation of the physical cameras (shared by every panel showing them). */
  camState: CameraStates;
  /** Secondary monitor window. */
  monitor: MonitorSettings;
  /** Lighting multipliers (1 = default). */
  lighting: LightingSettings;
  /** Sonar display/processing preferences. */
  sonar: SonarSettings;
  /** Settings schema version (for migrations). */
  version: number;
  /** Beginner docking assistance (larger capture envelope). */
  dockAssist: boolean;
  /** Default Top-Hat operating depth (m). */
  tmsDepth: number;
}

export type ViewLayout = 'single' | 'dual' | 'quad';
export type ViewSource = 'operational' | 'auxiliary' | 'external' | 'tms' | 'tether' | 'sonar' | 'instruments';

export interface CamPose {
  pan: number;
  tilt: number;
  zoom: number;
}
export interface CameraStates {
  operational: CamPose;
  auxiliary: CamPose;
  tether: CamPose;
}
export const DEFAULT_CAM_STATES: CameraStates = {
  operational: { pan: 0, tilt: -10, zoom: 1 },
  auxiliary: { pan: 0, tilt: 0, zoom: 1 },
  tether: { pan: 0, tilt: 0, zoom: 1 },
};
export interface MonitorSettings {
  layout: 'single' | 'dual';
  sources: ViewSource[];
  instruments: 'full' | 'compact' | 'hidden';
}
export interface LightingSettings {
  front: number;
  top: number;
  tms: number;
  /** Observer (external camera) assistance: non-physical light + exposure, external views only. */
  observer: 'normal' | 'assisted';
  /** Optional non-physical high-visibility rendering of the tether. */
  tetherAssist: boolean;
}
export interface SonarSettings {
  range: 10 | 20 | 40 | 60;
  gain: number;
  quality: 'low' | 'medium' | 'high';
  tilt: number;
}
export const SETTINGS_VERSION = 311;
export const VIEW_SOURCES: ViewSource[] = ['operational', 'auxiliary', 'external', 'tms', 'tether', 'sonar', 'instruments'];
const DEFAULT_PANELS: ViewSource[] = ['operational', 'sonar', 'tether', 'auxiliary'];

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
  visibility: 'normal',
  light: 'day',
  sea: 'calm',
  cameraFx: { ...DEFAULT_CAMERA_FX },
  volume: 0.7,
  showFps: false,
  showHints: true,
  mission: 'training',
  layout: 'single',
  panels: [...DEFAULT_PANELS],
  tetherBuoyancy: 'neutral',
  dockAssist: true,
  tmsDepth: 50,
  monitorSource: 'sonar',
  panelLocks: [false, true, true, true],
  camState: structuredClone(DEFAULT_CAM_STATES),
  monitor: { layout: 'dual', sources: ['external', 'tms'], instruments: 'compact' },
  lighting: { front: 1, top: 1, tms: 1, observer: 'assisted', tetherAssist: false },
  sonar: { range: 40, gain: 1, quality: 'medium', tilt: 15 },
  version: SETTINGS_VERSION,
};

const STORAGE_KEY = 'rov.settings.v1';
const QUALITIES: GraphicsQuality[] = ['low', 'medium', 'high'];
const MODES: PilotMode[] = ['manual', 'stabilize', 'depthHold'];
const CURRENTS: CurrentLevel[] = ['off', 'low', 'normal', 'strong'];
const VISIBILITIES: VisibilityLevel[] = ['clear', 'normal', 'turbid'];
const LIGHTS: LightLevel[] = ['day', 'overcast', 'night'];
const SEAS: SeaState[] = ['calm', 'moderate'];

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
    // v3.0 → v3.1 migration: the tether moved from O/I to the arrow keys.
    if ((k === 'tetherPay' && bindings[k].join() === 'KeyO') || (k === 'tetherHaul' && bindings[k].join() === 'KeyI')) bindings[k] = [...base[k]];
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
    visibility: pick(r.visibility, VISIBILITIES, d.visibility),
    light: pick(r.light, LIGHTS, d.light),
    sea: pick(r.sea, SEAS, d.sea),
    cameraFx: sanitizeCameraFx(r.cameraFx),
    volume: num(r.volume, 0, 1, d.volume),
    showFps: r.showFps === true,
    showHints: r.showHints !== false,
    mission: pick(r.mission, ['training', 'inspection', 'adverse', 'tms', 'free'] as const, d.mission),
    layout: pick(r.layout, ['single', 'dual', 'quad'] as const, d.layout),
    panels: DEFAULT_PANELS.map((def, i) => pick(Array.isArray(r.panels) ? r.panels[i] : undefined, VIEW_SOURCES, def)),
    dockAssist: r.dockAssist !== false,
    monitorSource: pick(r.monitorSource, VIEW_SOURCES, d.monitorSource),
    // v3.1 → v3.1.1: the old default release depth (80 m) was found too deep; only migrate the untouched default.
    tmsDepth: typeof r.version !== 'number' && r.tmsDepth === 80 ? d.tmsDepth : num(r.tmsDepth, 20, 100, d.tmsDepth),
    panelLocks: d.panelLocks.map((def, i) => (Array.isArray(r.panelLocks) && typeof r.panelLocks[i] === 'boolean' ? (r.panelLocks[i] as boolean) : def)),
    camState: sanitizeCamStates(r.camState),
    monitor: sanitizeMonitor(r.monitor, r.monitorSource),
    lighting: sanitizeLighting(r.lighting),
    sonar: sanitizeSonar(r.sonar),
    version: SETTINGS_VERSION,
    tetherBuoyancy: pick(r.tetherBuoyancy, ['positive', 'neutral', 'negative'] as const, d.tetherBuoyancy),
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function sanitizeCamStates(raw: unknown): CameraStates {
  const r = obj(raw);
  const pose = (k: keyof CameraStates): CamPose => {
    const p = obj(r[k]);
    const d = DEFAULT_CAM_STATES[k];
    return { pan: num(p.pan, -150, 150, d.pan), tilt: num(p.tilt, -70, 60, d.tilt), zoom: num(p.zoom, 0.35, 1, d.zoom) };
  };
  return { operational: pose('operational'), auxiliary: pose('auxiliary'), tether: pose('tether') };
}
function sanitizeMonitor(raw: unknown, legacySource: unknown): MonitorSettings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS.monitor;
  const legacy = VIEW_SOURCES.includes(legacySource as ViewSource) ? (legacySource as ViewSource) : null;
  const src = Array.isArray(r.sources) ? r.sources : legacy ? [legacy, d.sources[1]] : d.sources;
  return {
    layout: pick(r.layout, ['single', 'dual'] as const, legacy && !raw ? 'single' : d.layout),
    sources: [0, 1].map((i) => pick(src[i], VIEW_SOURCES, d.sources[i])),
    instruments: pick(r.instruments, ['full', 'compact', 'hidden'] as const, d.instruments),
  };
}
function sanitizeLighting(raw: unknown): LightingSettings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS.lighting;
  return {
    front: num(r.front, 0.25, 2, d.front),
    top: num(r.top, 0, 3, d.top),
    tms: num(r.tms, 0.25, 3, d.tms),
    observer: pick(r.observer, ['normal', 'assisted'] as const, d.observer),
    tetherAssist: r.tetherAssist === true,
  };
}
function sanitizeSonar(raw: unknown): SonarSettings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS.sonar;
  return {
    range: pick(r.range, [10, 20, 40, 60] as const, d.range),
    gain: num(r.gain, 0.3, 3, d.gain),
    quality: pick(r.quality, ['low', 'medium', 'high'] as const, d.quality),
    tilt: num(r.tilt, 0, 45, d.tilt),
  };
}

function sanitizeCameraFx(raw: unknown): CameraFx {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CAMERA_FX;
  return {
    distortion: num(r.distortion, 0, 1, d.distortion),
    noise: num(r.noise, 0, 1, d.noise),
    vignette: num(r.vignette, 0, 1, d.vignette),
    autoExposure: typeof r.autoExposure === 'boolean' ? r.autoExposure : d.autoExposure,
    exposureBias: num(r.exposureBias, -1.5, 1.5, d.exposureBias),
    contrast: num(r.contrast, 0.8, 1.3, d.contrast),
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
