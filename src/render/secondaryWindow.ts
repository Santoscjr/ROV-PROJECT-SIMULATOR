import { ACESFilmicToneMapping, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, type Object3D, type Scene } from 'three';
import { SecondaryView, glViewport, isCameraSource, layoutRects, type Rect } from './station';
import type { UnderwaterPass } from './underwaterPass';
import { Sonar } from './sonar';
import type { CameraFx, CameraStates, MonitorSettings, SonarSettings, ViewSource } from '../config/settings';
import { VIEW_SOURCES } from '../config/settings';
import { t } from '../i18n';
import type { InstrumentPanel } from '../ui/stationUi';
import type { HudData } from '../ui/hud';
import type { Collider } from '../sim/site';

export interface WindowFrame {
  scene: Scene;
  dt: number;
  time: number;
  rovRoot: Object3D;
  eye: Object3D;
  headingRad: number;
  tmsMount: Object3D | null;
  mainPass: UnderwaterPass;
  fxFor: (mode: string) => CameraFx;
  terrainHeight: (x: number, z: number) => number;
  whiteBalance: (depth: number) => number;
  /** Prepare scene lighting for a view (observer aid on external views only). */
  observer: (mode: string, pos: Vector3) => void;
  rovPos: Vector3;
  heading: number;
  running: boolean;
}

const BAR_H = 31;
const PANEL_SEL = 'mp-src';

/**
 * Independent browser window for a second physical monitor (1 or 2 panels).
 * The main window owns the only simulation and renders each panel into this
 * window's single canvas (one extra WebGL context, scissored viewports) in the
 * same frame. The popup page only lays itself out and, when it (or the main
 * window) is reloaded, asks the main window to adopt it again, so the link is
 * recovered without a new popup. Keyboard events typed in this window are
 * forwarded to the main window's keyboard device (no duplicate input path).
 */
export class SecondaryWindow {
  private win: Window | null = null;
  private doc: Document | null = null;
  private renderer: WebGLRenderer | null = null;
  private readonly views: (SecondaryView | null)[] = [null, null];
  private readonly sonars: (Sonar | null)[] = [null, null];
  private instr: InstrumentPanel | null = null;
  private frames: HTMLDivElement[] = [];
  private bar: HTMLDivElement | null = null;
  private barT = 0;
  private sonarCfg: SonarSettings | null = null;
  private readonly size = new Vector2();
  /** Called when settings change from this window's own selectors. */
  onChange: (m: MonitorSettings) => void = () => {};
  /** Window attached / detached (keyboard forwarding). */
  onAttach: (w: Window) => void = () => {};
  onDetach: (w: Window) => void = () => {};

  constructor(
    private readonly terrain: (x: number, z: number) => number,
    private readonly colliders: readonly Collider[],
    private readonly instrFactory: (doc: Document) => InstrumentPanel,
    private readonly camStates: CameraStates,
    public settings: MonitorSettings,
  ) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Must be called from a user gesture (popup blockers). The page adopts itself on load. */
  open(): boolean {
    if (this.isOpen) {
      this.win!.focus();
      return true;
    }
    const win = window.open('./monitor.html', 'rov-monitor-2', 'popup,width=1280,height=760');
    if (!win) return false;
    this.win = win;
    return true;
  }

  /** Settings changed in the main window (menus / reset). */
  setSettings(m: MonitorSettings): void {
    this.settings = m;
    this.syncControls();
  }

  setSonar(cfg: SonarSettings): void {
    this.sonarCfg = cfg;
    for (const s of this.sonars) s?.configure(cfg);
  }

  /**
   * Bind (or re-bind after a reload of either window) to a monitor page.
   * Called by the popup itself through `opener.__rovAdoptMonitor(window)`.
   */
  adopt(win: Window): void {
    // Already bound to this very page (e.g. the main window was only hidden): nothing to do.
    if (win === this.win && win.document === this.doc && this.renderer) return;
    if (this.win && this.win !== win) this.dispose();
    if (this.win) this.onDetach(this.win);
    this.releaseGpu();
    this.win = win;
    const doc = win.document;
    this.doc = doc;
    const host = doc.getElementById('host');
    if (!host) return;
    // Fresh canvas → fresh WebGL context (a reloaded main window cannot reuse the old one).
    const old = doc.getElementById('view');
    const canvas = doc.createElement('canvas');
    canvas.id = 'view';
    if (old) old.replaceWith(canvas);
    else host.prepend(canvas);
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.renderer.autoClear = true;
    this.buildControls(doc, host);
    this.bindPointer(canvas);
    const status = doc.getElementById('status');
    if (status) status.textContent = t('monitor.synced');
    this.onAttach(win);
  }

  private buildControls(doc: Document, host: HTMLElement): void {
    const opt = (vals: readonly string[], key: (v: string) => string) => vals.map((v) => `<option value="${v}">${t(key(v))}</option>`).join('');
    const lay = doc.getElementById('layout') as HTMLSelectElement | null;
    const ins = doc.getElementById('instr') as HTMLSelectElement | null;
    if (lay) {
      lay.innerHTML = opt(['single', 'dual'], (v) => 'monitor.layout.' + v);
      lay.onchange = () => {
        this.emit({ layout: lay.value as MonitorSettings['layout'] });
        lay.blur();
      };
    }
    if (ins) {
      ins.innerHTML = opt(['full', 'compact', 'hidden'], (v) => 'monitor.instr.' + v);
      ins.onchange = () => {
        this.emit({ instruments: ins.value as MonitorSettings['instruments'] });
        ins.blur();
      };
    }
    host.querySelectorAll('.mp').forEach((e) => e.remove());
    this.frames = [0, 1].map((i) => {
      const f = doc.createElement('div');
      f.className = 'mp';
      f.innerHTML = `<div class="mp-head"><span>${i + 1}</span><select class="${PANEL_SEL}" aria-label="${t('station.source')}">${opt(VIEW_SOURCES, (v) => 'view.' + v)}</select></div><div class="mp-host"></div>`;
      const sel = f.querySelector('select') as HTMLSelectElement;
      sel.onchange = () => {
        const sources = [...this.settings.sources];
        sources[i] = sel.value as ViewSource;
        this.emit({ sources });
        sel.blur();
      };
      host.appendChild(f);
      return f;
    });
    this.bar?.remove();
    this.bar = doc.createElement('div');
    this.bar.className = 'mbar';
    host.appendChild(this.bar);
    this.syncControls();
  }

  private emit(patch: Partial<MonitorSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.syncControls();
    this.onChange(this.settings);
  }

  private syncControls(): void {
    const doc = this.doc;
    if (!doc) return;
    const lay = doc.getElementById('layout') as HTMLSelectElement | null;
    const ins = doc.getElementById('instr') as HTMLSelectElement | null;
    if (lay && lay.value !== this.settings.layout) lay.value = this.settings.layout;
    if (ins && ins.value !== this.settings.instruments) ins.value = this.settings.instruments;
    this.frames.forEach((f, i) => {
      const sel = f.querySelector('select') as HTMLSelectElement;
      if (sel.value !== this.settings.sources[i]) sel.value = this.settings.sources[i];
    });
  }

  private rects(): Rect[] {
    const win = this.win!;
    const w = Math.max(1, win.innerWidth);
    const h = Math.max(1, win.innerHeight - BAR_H);
    return layoutRects(this.settings.layout, w, h);
  }

  /** Mouse on a monitor panel moves that panel's camera only. */
  private bindPointer(canvas: HTMLCanvasElement): void {
    let drag = -1;
    let lx = 0;
    let ly = 0;
    const at = (e: PointerEvent | WheelEvent) => {
      const b = canvas.getBoundingClientRect();
      const x = e.clientX - b.left;
      const y = e.clientY - b.top;
      return this.rects().findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    };
    canvas.addEventListener('pointerdown', (e) => {
      drag = at(e);
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      this.views[drag]?.rig.drag(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = () => (drag = -1);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const i = at(e);
        if (i >= 0) this.views[i]?.rig.wheel(e.deltaY, e.ctrlKey || e.altKey);
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Render every panel (called by the main loop once per frame). */
  render(f: WindowFrame): void {
    const win = this.win;
    if (!win) return;
    if (win.closed) {
      this.dispose();
      return;
    }
    // The popup was reloaded and has not re-adopted yet: wait for it.
    if (win.document !== this.doc || !this.renderer) return;
    (win as unknown as { __rovHeartbeat?: number }).__rovHeartbeat = performance.timeOrigin + performance.now();
    const renderer = this.renderer;
    const W = Math.max(1, win.innerWidth);
    const H = Math.max(1, win.innerHeight - BAR_H);
    const pr = Math.min(win.devicePixelRatio || 1, 1.5);
    if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
    const size = renderer.getSize(this.size);
    if (size.x !== W || size.y !== H) renderer.setSize(W, H, false);
    const rects = this.rects();
    renderer.setScissorTest(true);
    let instrShown = false;
    for (let i = 0; i < 2; i++) {
      const frame = this.frames[i];
      const r = rects[i];
      if (frame) {
        frame.hidden = !r;
        if (r) Object.assign(frame.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      }
      const src = this.settings.sources[i];
      const panelHost = frame?.querySelector('.mp-host') as HTMLElement | null;
      // Sonar
      const sonarEl = this.sonars[i]?.canvas;
      if (r && src === 'sonar') {
        const sonar = (this.sonars[i] ??= this.makeSonar());
        const el = sonar.canvas;
        if (el.ownerDocument !== this.doc) this.doc.adoptNode(el);
        if (el.parentElement !== panelHost) panelHost?.appendChild(el);
        if (f.running) sonar.scan(f.rovPos, f.heading);
        sonar.draw(r.w, r.h);
      } else sonarEl?.remove();
      // Instrumentation source (one instance per window).
      if (r && src === 'instruments' && !instrShown) {
        instrShown = true;
        this.instr ??= this.instrFactory(this.doc);
        if (this.instr.root.parentElement !== panelHost) panelHost?.appendChild(this.instr.root);
      }
      if (!r || !isCameraSource(src)) {
        if (this.views[i]?.pass) this.views[i]!.dispose();
        continue;
      }
      const view = (this.views[i] ??= new SecondaryView(src, this.camStates));
      if (view.source !== src) view.setSource(src);
      const vp = glViewport(r, H, pr);
      const pass = view.ensurePass(vp.w, vp.h);
      pass.setWater(f.mainPass.optics);
      const rig = view.rig;
      rig.tmsMount = f.tmsMount;
      rig.camera.aspect = r.w / r.h;
      rig.update(f.dt, f.rovRoot, f.eye, f.headingRad);
      const cam = rig.camera;
      const d = -cam.position.y;
      f.observer(rig.mode, cam.position);
      pass.setCameraFx(f.fxFor(src), src === 'operational' || src === 'auxiliary');
      pass.update(cam, { camDepth: d, seabedDepth: -f.terrainHeight(cam.position.x, cam.position.z) || 120, time: f.time, wet: 0, whiteBalance: f.whiteBalance(d) });
      renderer.setViewport(vp.x / pr, vp.y / pr, vp.w / pr, vp.h / pr);
      renderer.setScissor(vp.x / pr, vp.y / pr, vp.w / pr, vp.h / pr);
      pass.render(renderer, f.scene, cam);
    }
    renderer.setScissorTest(false);
    if (!instrShown) this.instr?.root.remove();
  }

  private makeSonar(): Sonar {
    const s = new Sonar(this.terrain, this.colliders);
    if (this.sonarCfg) s.configure(this.sonarCfg);
    return s;
  }

  /** Instrumentation panel instance living in this window (if shown). */
  get instruments(): InstrumentPanel | null {
    return this.isOpen && this.settings.sources.slice(0, this.settings.layout === 'dual' ? 2 : 1).includes('instruments') ? this.instr : null;
  }

  /** Instrument bar of the monitor window (full / compact / hidden), ~10 Hz. */
  updateBar(d: HudData): void {
    const bar = this.bar;
    if (!bar || !this.isOpen) return;
    const mode = this.settings.instruments;
    bar.hidden = mode === 'hidden';
    bar.dataset.mode = mode;
    if (mode === 'hidden') return;
    const now = performance.now();
    if (now - this.barT < 100) return;
    this.barT = now;
    bar.innerHTML = instrumentRows(d, mode === 'full')
      .map(([k, v, c]) => `<div${c ? ` class="${c}"` : ''}><span>${k}</span><b>${v}</b></div>`)
      .join('');
  }

  private releaseGpu(): void {
    this.views.forEach((v, i) => {
      v?.dispose();
      this.views[i] = null;
    });
    this.renderer?.dispose();
    this.renderer = null;
  }

  /** Main window unloading: drop GPU resources and listeners but keep the popup open
   *  (it re-attaches itself when the main window comes back). */
  unlink(): void {
    this.releaseGpu();
    if (this.win) this.onDetach(this.win);
  }

  /** Close the window and free its GPU resources (camera orientation lives in shared state). */
  dispose(): void {
    this.releaseGpu();
    this.sonars.fill(null);
    this.instr = null;
    this.frames = [];
    this.bar = null;
    const win = this.win;
    this.win = null;
    this.doc = null;
    if (win) {
      this.onDetach(win);
      if (!win.closed) win.close();
    }
  }
}

const fmt = (v: number, n = 1) => v.toFixed(n);
const pad3 = (v: number) => String(Math.round(((v % 360) + 360) % 360) % 360).padStart(3, '0');

/** Essential readouts shared by the monitor instrument bar (compact = one row). */
export function instrumentRows(d: HudData, full: boolean): [string, string, string?][] {
  const tm = d.tms;
  const rows: [string, string, string?][] = [
    [t('hud.depth'), `${fmt(Math.max(0, d.depth))} m`],
    [t('hud.altitude'), d.altitude === null ? '---' : `${fmt(d.altitude)} m`],
    [t('hud.heading'), `${pad3(d.heading)}°`],
    [t('hud.pitch'), `${fmt(d.pitch)}°`],
    [t('hud.roll'), `${fmt(d.roll)}°`],
    [t('hud.speed'), d.dvl ? `${fmt(Math.hypot(d.dvl.surge, d.dvl.sway), 2)} m/s` : '---'],
    [t('hud.mode'), t('hud.mode.' + d.mode)],
    ['TETHER', `${fmt(tm.payout, 0)} m · ${fmt(tm.tension / 1000, 1)} kN`, tm.tension > tm.tensionWarn || tm.slack > tm.slackWarn ? 'warn' : ''],
  ];
  if (full)
    rows.push(
      [t('hud.vspeed'), `${fmt(d.verticalSpeed, 2)} m/s`],
      [t('hud.tms.slack'), `${fmt(tm.slack)} m`],
      ['TMS', `${tm.mode === 'auto' ? 'AUTO' : 'MAN'} · ${t('hud.tms.state.' + tm.state)}`],
      ['TOP-HAT', t('lars.' + d.larsState)],
      [t('hud.lights'), d.lightsOn ? `${Math.round(d.lightLevel * 100)}%` : t('hud.off')],
    );
  return rows;
}
