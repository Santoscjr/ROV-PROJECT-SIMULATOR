/**
 * Optional 3Dconnexion SpaceMouse input via WebHID (Chromium desktop only,
 * secure context). Everything DOM-related is feature-detected at call time so
 * this module can be imported (and its pure helpers tested) under Node.
 */
import { AXIS_NAMES, zeroAxes } from '../types';
import type { AxisCommand, AxisName, InputDevice, PilotAction } from '../types';
import {
  HID_REQUEST_FILTERS,
  VID_3DCONNEXION,
  HID_USAGE_MULTI_AXIS,
  HID_USAGE_PAGE_GENERIC_DESKTOP,
  hexDump,
  lookupDevice,
  parseReport,
  risingEdges,
  type ButtonLayout,
} from './hidParser';

// ---------------------------------------------------------------------------
// Config (plain JSON)
// ---------------------------------------------------------------------------

/** Raw device axes in HID order. */
export type RawAxis = 'tx' | 'ty' | 'tz' | 'rx' | 'ry' | 'rz';
export const RAW_AXES: readonly RawAxis[] = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];

export interface RawAxisMapping {
  /** Pilot axis driven by this device axis, or 'none'. */
  target: AxisName | 'none';
  invert: boolean;
  /** Per-axis gain multiplier (on top of the global sensitivity). */
  scale: number;
}

export type ButtonActionMap = Record<string, PilotAction | 'none'>;

export interface SpaceMouseConfig {
  version: 1;
  /** Raw count treated as full deflection (3Dconnexion devices send ~±350). */
  fullScale: number;
  /** Fraction of full scale ignored around zero, 0..0.5. */
  deadzone: number;
  /** Global gain, 0.1..3. Output is clamped to [-1, 1]. */
  sensitivity: number;
  /** Response curve exponent: 1 = linear, >1 = finer near center. */
  expo: number;
  axes: Record<RawAxis, RawAxisMapping>;
  /** Raw resting values captured by calibrate(), subtracted before mapping. */
  offsets: Record<RawAxis, number>;
  /** HID button bit index (as string) -> action. */
  buttons: ButtonActionMap;
}

export const SPACEMOUSE_STORAGE_KEY = 'rov.spacemouse.v1';

/**
 * Defaults assume the (unverified) raw convention X+ right, Y+ toward user,
 * Z+ down, right-handed rotations:
 *  push cap forward  -> ty < 0 -> surge + (inverted)
 *  push cap right    -> tx > 0 -> sway +
 *  lift cap          -> tz < 0 -> heave + (inverted)
 *  twist clockwise   -> rz > 0 -> yaw +   (rotation about "down" axis)
 *  tilt cap back     -> rx > 0 -> camTilt + (camera up)
 *  tilt cap right    -> ry < 0 -> roll + if assigned (inverted; off by default)
 * If hardware disagrees, flip the "invert" box on the diagnostic page.
 */
export const DEFAULT_SPACEMOUSE_CONFIG: SpaceMouseConfig = Object.freeze({
  version: 1,
  fullScale: 350,
  deadzone: 0.08,
  sensitivity: 1,
  expo: 1.4,
  axes: {
    tx: { target: 'sway', invert: false, scale: 1 },
    ty: { target: 'surge', invert: true, scale: 1 },
    tz: { target: 'heave', invert: true, scale: 1 },
    rx: { target: 'camTilt', invert: false, scale: 1 },
    ry: { target: 'none', invert: true, scale: 1 },
    rz: { target: 'yaw', invert: false, scale: 1 },
  },
  offsets: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
  buttons: {
    // Bit 0/1: left/right on two-button models, Menu/Fit on SpaceMouse Pro.
    '0': 'toggleCamera',
    '1': 'toggleLights',
    // SpaceMouse Pro extras.
    '2': 'lightsUp', // T
    '4': 'lightsDown', // R
    '5': 'camTiltCenter', // F
    '12': 'modeManual', // 1
    '13': 'modeStabilize', // 2
    '14': 'modeDepthHold', // 3
    '15': 'cycleMode', // 4
    '22': 'pause', // Esc
    '24': 'fineControl', // Shift
  },
}) as SpaceMouseConfig;

export function cloneConfig(c: SpaceMouseConfig): SpaceMouseConfig {
  return JSON.parse(JSON.stringify(c)) as SpaceMouseConfig;
}

export function defaultConfig(): SpaceMouseConfig {
  return cloneConfig(DEFAULT_SPACEMOUSE_CONFIG);
}

const VALID_TARGETS = new Set<string>([...AXIS_NAMES, 'none']);
const clampNum = (v: unknown, lo: number, hi: number, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;

/** Merge untrusted JSON onto the defaults, dropping anything invalid. */
export function sanitizeConfig(input: unknown): SpaceMouseConfig {
  const d = defaultConfig();
  if (!input || typeof input !== 'object') return d;
  const o = input as Partial<SpaceMouseConfig>;
  d.fullScale = clampNum(o.fullScale, 50, 2000, d.fullScale);
  d.deadzone = clampNum(o.deadzone, 0, 0.5, d.deadzone);
  d.sensitivity = clampNum(o.sensitivity, 0.1, 3, d.sensitivity);
  d.expo = clampNum(o.expo, 1, 3, d.expo);
  for (const a of RAW_AXES) {
    const m = o.axes?.[a];
    if (m && typeof m === 'object') {
      if (typeof m.target === 'string' && VALID_TARGETS.has(m.target)) d.axes[a].target = m.target;
      if (typeof m.invert === 'boolean') d.axes[a].invert = m.invert;
      d.axes[a].scale = clampNum(m.scale, 0, 3, d.axes[a].scale);
    }
    d.offsets[a] = clampNum(o.offsets?.[a], -1000, 1000, 0);
  }
  if (o.buttons && typeof o.buttons === 'object') {
    const b: ButtonActionMap = {};
    for (const [k, v] of Object.entries(o.buttons)) {
      const bit = Number(k);
      if (Number.isInteger(bit) && bit >= 0 && bit < 32 && typeof v === 'string') b[String(bit)] = v as PilotAction | 'none';
    }
    d.buttons = b;
  }
  return d;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSpaceMouseConfig(storage: Storage | null = getStorage()): SpaceMouseConfig {
  try {
    const s = storage?.getItem(SPACEMOUSE_STORAGE_KEY);
    return s ? sanitizeConfig(JSON.parse(s)) : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export function saveSpaceMouseConfig(cfg: SpaceMouseConfig, storage: Storage | null = getStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SPACEMOUSE_STORAGE_KEY, JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mapping math (pure)
// ---------------------------------------------------------------------------

/** Deadzone with rescale so output is continuous: |v|<=dz -> 0, |v|=1 -> 1. */
export function applyDeadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  if (dz >= 1) return 0;
  return (Math.sign(v) * (a - dz)) / (1 - dz);
}

/** Raw counts -> normalised [-1, 1] value for one axis. */
export function processRawAxis(raw: number, offset: number, mapping: RawAxisMapping, cfg: SpaceMouseConfig): number {
  let v = (raw - offset) / cfg.fullScale;
  v = Math.max(-1, Math.min(1, v));
  v = applyDeadzone(v, cfg.deadzone);
  if (cfg.expo !== 1 && v !== 0) v = Math.sign(v) * Math.pow(Math.abs(v), cfg.expo);
  v *= cfg.sensitivity * mapping.scale;
  if (mapping.invert) v = -v;
  return Math.max(-1, Math.min(1, v)) || 0;
}

/** Map six raw values to pilot axes. Several sources on one target are summed then clamped. */
export function mapAxes(raw: Record<RawAxis, number>, cfg: SpaceMouseConfig): AxisCommand {
  const out = zeroAxes();
  for (const a of RAW_AXES) {
    const m = cfg.axes[a];
    if (m.target === 'none') continue;
    out[m.target] += processRawAxis(raw[a], cfg.offsets[a], m, cfg);
  }
  for (const k of AXIS_NAMES) out[k] = Math.max(-1, Math.min(1, out[k]));
  return out;
}

/** Actions fired by the rising edges between two button masks. */
export function buttonActions(prev: number, next: number, map: ButtonActionMap): PilotAction[] {
  const out: PilotAction[] = [];
  for (const bit of risingEdges(prev, next)) {
    const a = map[String(bit)];
    if (a && a !== 'none') out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebHID device (loosely typed, no @types/w3c-web-hid)
// ---------------------------------------------------------------------------

interface HIDInputReportEventLike extends Event {
  reportId: number;
  data: DataView;
  device: HIDDeviceLike;
}
interface HIDDeviceLike extends EventTarget {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections?: { usagePage?: number; usage?: number }[];
  open(): Promise<void>;
  close(): Promise<void>;
}
interface HIDLike extends EventTarget {
  requestDevice(opts: { filters: object[] }): Promise<HIDDeviceLike[]>;
  getDevices(): Promise<HIDDeviceLike[]>;
}

function getHid(): HIDLike | null {
  if (typeof navigator === 'undefined') return null;
  const hid = (navigator as unknown as { hid?: HIDLike }).hid;
  return hid ?? null;
}

export interface SpaceMouseInfo {
  name: string;
  vendorId: number;
  productId: number;
  layout: ButtonLayout;
  known: boolean;
}

export interface SpaceMouseRawState {
  axes: Record<RawAxis, number>;
  buttons: number;
}

export type SpaceMouseEvent = 'connect' | 'disconnect' | 'report' | 'error';

function isCandidate(d: HIDDeviceLike): boolean {
  if (d.vendorId === VID_3DCONNEXION) return true;
  if (lookupDevice(d.vendorId, d.productId)) return true;
  // Unknown PID (e.g. a newer Logitech/3Dconnexion model): accept any multi-axis controller.
  return (d.collections ?? []).some(
    (c) => c.usagePage === HID_USAGE_PAGE_GENERIC_DESKTOP && c.usage === HID_USAGE_MULTI_AXIS,
  );
}

export class SpaceMouseDevice implements InputDevice {
  readonly id = 'spacemouse';
  label = 'SpaceMouse';

  private device: HIDDeviceLike | null = null;
  private info: SpaceMouseInfo | null = null;
  private config: SpaceMouseConfig;
  private raw: SpaceMouseRawState = { axes: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 }, buttons: 0 };
  private polledButtons = 0;
  private pendingActions: PilotAction[] = [];
  private listeners = new Map<SpaceMouseEvent, Set<(arg?: unknown) => void>>();
  private lastReportAt = 0;
  private lastReport: { reportId: number; hex: string; byteLength: number } | null = null;
  private reportTimes: number[] = [];
  private hidListenersAttached = false;
  private disposed = false;

  constructor(opts: { config?: SpaceMouseConfig; loadFromStorage?: boolean } = {}) {
    this.config = opts.config
      ? sanitizeConfig(opts.config)
      : opts.loadFromStorage === false
        ? defaultConfig()
        : loadSpaceMouseConfig();
  }

  /** WebHID present and secure context (HTTPS or localhost). */
  static isSupported(): boolean {
    return getHid() !== null && (typeof isSecureContext === 'undefined' || isSecureContext);
  }

  /** pt-BR reason when unsupported, or null. */
  static unsupportedReason(): string | null {
    if (typeof navigator === 'undefined') return 'Ambiente sem navegador.';
    if (typeof isSecureContext !== 'undefined' && !isSecureContext)
      return 'WebHID exige contexto seguro (HTTPS ou localhost).';
    if (!getHid())
      return 'Este navegador não implementa WebHID. Use Chrome, Edge ou Opera para desktop (Firefox e Safari não suportam).';
    return null;
  }

  // --- events -------------------------------------------------------------

  on(ev: SpaceMouseEvent, cb: (arg?: unknown) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(ev: SpaceMouseEvent, arg?: unknown): void {
    this.listeners.get(ev)?.forEach((cb) => {
      try {
        cb(arg);
      } catch (e) {
        console.error(e);
      }
    });
  }

  // --- connection ---------------------------------------------------------

  /** Shows the browser chooser. MUST be called from a user gesture (click/keydown). */
  async requestAndOpen(): Promise<boolean> {
    const hid = getHid();
    if (!hid) return false;
    this.attachHidListeners();
    let devices: HIDDeviceLike[];
    try {
      devices = await hid.requestDevice({ filters: HID_REQUEST_FILTERS });
    } catch (e) {
      this.emit('error', e);
      return false;
    }
    const d = devices.find(isCandidate) ?? devices[0];
    return d ? this.openDevice(d) : false;
  }

  /** Reopens a device the user granted earlier, without a prompt. */
  async reconnectGranted(): Promise<boolean> {
    const hid = getHid();
    if (!hid) return false;
    this.attachHidListeners();
    try {
      const devices = (await hid.getDevices()).filter(isCandidate);
      for (const d of devices) if (await this.openDevice(d)) return true;
    } catch (e) {
      this.emit('error', e);
    }
    return false;
  }

  /** Close the device (permission is kept; reconnectGranted() can reopen). */
  async close(): Promise<void> {
    const d = this.device;
    if (!d) return;
    this.detachDevice();
    try {
      if (d.opened) await d.close();
    } catch {
      /* ignore */
    }
    this.emit('disconnect');
  }

  private async openDevice(d: HIDDeviceLike): Promise<boolean> {
    if (this.device === d && d.opened) return true;
    if (this.device) await this.close();
    try {
      if (!d.opened) await d.open();
    } catch (e) {
      this.emit('error', e);
      return false;
    }
    const known = lookupDevice(d.vendorId, d.productId);
    this.info = {
      name: known?.name ?? (d.productName || 'Dispositivo HID multi-eixo'),
      vendorId: d.vendorId,
      productId: d.productId,
      layout: known?.layout ?? 'generic',
      known: !!known,
    };
    this.label = this.info.name;
    this.device = d;
    this.resetState();
    d.addEventListener('inputreport', this.onInputReport);
    this.emit('connect', this.info);
    return true;
  }

  private detachDevice(): void {
    this.device?.removeEventListener('inputreport', this.onInputReport);
    this.device = null;
    this.resetState();
  }

  private resetState(): void {
    for (const a of RAW_AXES) this.raw.axes[a] = 0;
    this.raw.buttons = 0;
    this.polledButtons = 0;
    this.pendingActions = [];
    this.reportTimes = [];
    this.lastReportAt = 0;
  }

  private attachHidListeners(): void {
    const hid = getHid();
    if (!hid || this.hidListenersAttached) return;
    hid.addEventListener('disconnect', this.onHidDisconnect);
    hid.addEventListener('connect', this.onHidConnect);
    this.hidListenersAttached = true;
  }

  private onHidDisconnect = (ev: Event): void => {
    const d = (ev as unknown as { device: HIDDeviceLike }).device;
    if (d && d === this.device) {
      this.detachDevice();
      this.emit('disconnect');
    }
  };

  private onHidConnect = (ev: Event): void => {
    const d = (ev as unknown as { device: HIDDeviceLike }).device;
    if (!this.device && d && isCandidate(d) && !this.disposed) void this.openDevice(d);
  };

  private onInputReport = (ev: Event): void => {
    const e = ev as HIDInputReportEventLike;
    this.ingestReport(e.reportId, e.data, performance.now());
  };

  /** Feed a report (public so tests/diagnostics can inject data). */
  ingestReport(reportId: number, data: DataView, now = 0): void {
    const p = parseReport(reportId, data);
    if (p.translation) [this.raw.axes.tx, this.raw.axes.ty, this.raw.axes.tz] = p.translation;
    if (p.rotation) [this.raw.axes.rx, this.raw.axes.ry, this.raw.axes.rz] = p.rotation;
    if (p.buttons !== undefined) {
      // Accumulate edges here so a press+release between two polls isn't lost.
      this.pendingActions.push(...buttonActions(this.raw.buttons, p.buttons, this.config.buttons));
      this.raw.buttons = p.buttons;
    }
    this.lastReportAt = now;
    this.lastReport = { reportId, hex: hexDump(reportId, data), byteLength: data.byteLength };
    this.reportTimes.push(now);
    while (this.reportTimes.length && now - this.reportTimes[0] > 1000) this.reportTimes.shift();
    this.emit('report', p);
  }

  // --- InputDevice --------------------------------------------------------

  connected(): boolean {
    return !!this.device && this.device.opened;
  }

  poll(): { axes: Partial<AxisCommand>; actions: PilotAction[] } {
    const actions = this.pendingActions;
    this.pendingActions = [];
    this.polledButtons = this.raw.buttons;
    if (!this.connected()) return { axes: {}, actions };
    return { axes: mapAxes(this.raw.axes, this.config), actions };
  }

  dispose(): void {
    this.disposed = true;
    const hid = getHid();
    if (hid && this.hidListenersAttached) {
      hid.removeEventListener('disconnect', this.onHidDisconnect);
      hid.removeEventListener('connect', this.onHidConnect);
      this.hidListenersAttached = false;
    }
    void this.close();
    this.listeners.clear();
  }

  // --- state / diagnostics -----------------------------------------------

  getInfo(): SpaceMouseInfo | null {
    return this.info ? { ...this.info } : null;
  }

  getRawState(): SpaceMouseRawState {
    return { axes: { ...this.raw.axes }, buttons: this.raw.buttons };
  }

  /** Current mapped axes without consuming actions. */
  getMappedAxes(): AxisCommand {
    return mapAxes(this.raw.axes, this.config);
  }

  /** Button mask as of the last poll() (for held-button UIs). */
  getPolledButtons(): number {
    return this.polledButtons;
  }

  /** Reports received during the last second. */
  getReportRateHz(now = performance.now()): number {
    return this.reportTimes.filter((t) => now - t <= 1000).length;
  }

  /** ms since the last input report, or Infinity if none yet. */
  msSinceLastReport(now = performance.now()): number {
    return this.lastReportAt ? now - this.lastReportAt : Infinity;
  }

  getLastReport(): { reportId: number; hex: string; byteLength: number } | null {
    return this.lastReport ? { ...this.lastReport } : null;
  }

  // --- config ------------------------------------------------------------

  getConfig(): SpaceMouseConfig {
    return cloneConfig(this.config);
  }

  setConfig(cfg: SpaceMouseConfig): void {
    this.config = sanitizeConfig(cfg);
  }

  /** Capture the current raw values (cap at rest!) as zero offsets. */
  calibrate(): void {
    for (const a of RAW_AXES) this.config.offsets[a] = this.raw.axes[a];
  }

  clearCalibration(): void {
    for (const a of RAW_AXES) this.config.offsets[a] = 0;
  }

  saveConfig(): boolean {
    return saveSpaceMouseConfig(this.config);
  }

  /** Restore defaults (in memory; call saveConfig() to persist). */
  resetConfig(): void {
    this.config = defaultConfig();
  }
}
