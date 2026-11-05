import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector2, WebGLRenderer, type Vector3 } from 'three';
import { SecondaryView, glViewport, isCameraSource, layoutRects, renderCameraPanel, type PanelEnv, type Rect } from './station';
import { Sonar } from './sonar';
import type { CameraStates, HudItems, MonitorSettings, SonarSettings, ViewSource } from '../config/settings';
import { VIEW_SOURCES } from '../config/settings';
import { t } from '../i18n';
import type { InstrumentPanel } from '../ui/stationUi';
import type { Hud, HudData } from '../ui/hud';
import type { Collider } from '../sim/site';
import { PANEL_OVERLAY_CSS, PanelOverlay, type CamReadout } from '../ui/panelOverlay';
import { instrumentRows } from './instrumentRows';

const BAR_H = 31;
const STRIP_H = { full: 54, compact: 34, hidden: 0 } as const;

export interface MonitorFrame extends PanelEnv {
  running: boolean;
  rovPos: Vector3;
  heading: number;
  /** Adaptive resolution factor and pixel-ratio cap of the quality preset. */
  scale: number;
  pixelRatioCap: number;
  msaa: number;
  shadows: boolean;
  /** Active panel of THIS window (-1 if the active panel is elsewhere). */
  active: number;
  hud: HudData | null;
  hudRef: Hud;
  hudItems: HudItems;
  camReadout: (source: ViewSource) => CamReadout | null;
}

/**
 * One additional monitor window (index k ≥ 0 → "MONITOR k+2"). The main window
 * owns the only simulation and draws this window's panels into its canvas with
 * ONE extra WebGL context and the same panel renderer as the main window
 * (`renderCameraPanel`). The page adopts itself through
 * `opener.__rovAdoptMonitor(window, k)` on load and after any reload.
 */
export class MonitorWindow {
  private win: Window | null = null;
  private doc: Document | null = null;
  private renderer: WebGLRenderer | null = null;
  private readonly views: (SecondaryView | null)[] = [null, null, null, null];
  private readonly sonars: (Sonar | null)[] = [null, null, null, null];
  private readonly overlays: (PanelOverlay | null)[] = [null, null, null, null];
  private instr: InstrumentPanel | null = null;
  private frames: HTMLDivElement[] = [];
  private strip: HTMLDivElement | null = null;
  private stripT = 0;
  private sonarCfg: SonarSettings | null = null;
  private readonly size = new Vector2();
  private msaa = 0;
  /** Draw calls / triangles of the last frame of this window. */
  stats = { calls: 0, triangles: 0 };
  /** Time (ms) of the last frame drawn — for the link diagnostics. */
  lastFrame = 0;
  onChange: (m: MonitorSettings) => void = () => {};
  onAttach: (w: Window) => void = () => {};
  onDetach: (w: Window) => void = () => {};
  onActivate: (panel: number) => void = () => {};

  constructor(
    readonly index: number,
    private readonly terrain: (x: number, z: number) => number,
    private readonly colliders: readonly Collider[],
    private readonly instrFactory: (doc: Document) => InstrumentPanel,
    private readonly camStates: CameraStates,
    public settings: MonitorSettings,
  ) {}

  get name(): string {
    return `rov-monitor-${this.index + 2}`;
  }

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Must be called from a user gesture (popup blockers). */
  open(): boolean {
    if (this.isOpen) {
      this.win!.focus();
      return true;
    }
    const win = window.open(`./monitor.html?m=${this.index}`, this.name, 'popup,width=1280,height=760');
    if (!win) return false;
    this.win = win;
    return true;
  }

  setSettings(m: MonitorSettings): void {
    this.settings = m;
    this.syncControls();
  }

  setSonar(cfg: SonarSettings): void {
    this.sonarCfg = cfg;
    for (const s of this.sonars) s?.configure(cfg);
  }

  adopt(win: Window): void {
    if (win === this.win && win.document === this.doc && this.renderer) return;
    if (this.win && this.win !== win) this.dispose();
    if (this.win) this.onDetach(this.win);
    this.releaseGpu();
    this.win = win;
    const doc = win.document;
    this.doc = doc;
    const host = doc.getElementById('host');
    if (!host) return;
    if (!doc.getElementById('pov-css')) {
      const st = doc.createElement('style');
      st.id = 'pov-css';
      st.textContent = PANEL_OVERLAY_CSS;
      doc.head.appendChild(st);
    }
    const title = doc.getElementById('title');
    if (title) title.textContent = `MONITOR ${this.index + 2}`;
    doc.title = `ROV — Monitor ${this.index + 2}`;
    const old = doc.getElementById('view');
    const canvas = doc.createElement('canvas');
    canvas.id = 'view';
    if (old) old.replaceWith(canvas);
    else host.prepend(canvas);
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
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
      lay.innerHTML = opt(['single', 'dual', 'quad'], (v) => 'monitor.layout.' + v);
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
    host.querySelectorAll('.mp,.mstrip').forEach((e) => e.remove());
    this.frames = [0, 1, 2, 3].map((i) => {
      const f = doc.createElement('div');
      f.className = 'mp';
      f.innerHTML = `<div class="mp-host"></div><div class="mp-head"><span class="mp-idx">${i + 1}</span><select aria-label="${t('station.source')}">${opt(VIEW_SOURCES, (v) => 'view.' + v)}</select><button type="button" class="mp-lock"></button></div>`;
      const sel = f.querySelector('select') as HTMLSelectElement;
      sel.onchange = () => {
        const sources = [...this.settings.sources];
        sources[i] = sel.value as ViewSource;
        this.onActivate(i);
        this.emit({ sources });
        sel.blur();
      };
      const lock = f.querySelector('.mp-lock') as HTMLButtonElement;
      lock.onclick = () => {
        const locks = [...this.settings.locks];
        locks[i] = !locks[i];
        this.emit({ locks });
        lock.blur();
      };
      f.querySelector('.mp-head')?.addEventListener('pointerdown', () => this.onActivate(i));
      host.appendChild(f);
      return f;
    });
    this.strip = doc.createElement('div');
    this.strip.className = 'mstrip';
    host.appendChild(this.strip);
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
      const locked = !!this.settings.locks[i];
      sel.disabled = locked;
      f.classList.toggle('locked', locked);
      const lock = f.querySelector('.mp-lock') as HTMLButtonElement;
      lock.textContent = t(locked ? 'station.lockedShort' : 'station.freeShort');
      lock.title = t(locked ? 'station.unlock' : 'station.lock');
    });
  }

  /** Panel rectangles (CSS px inside #host), above the reserved instrument strip. */
  rects(): Rect[] {
    const win = this.win!;
    const w = Math.max(1, win.innerWidth);
    const h = Math.max(1, win.innerHeight - BAR_H - STRIP_H[this.settings.instruments]);
    return layoutRects(this.settings.layout, w, h);
  }

  /** Camera rig of panel i of this window (null for sonar/instruments or not open). */
  rigFor(i: number) {
    const src = this.settings.sources[i];
    if (!isCameraSource(src)) return null;
    let v = this.views[i];
    if (!v || v.source !== src) {
      v?.dispose();
      v = this.views[i] = new SecondaryView(src, this.camStates, this.msaa);
    }
    return v.rig;
  }

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
      if (drag >= 0) this.onActivate(drag);
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      this.rigFor(drag)?.drag(e.clientX - lx, e.clientY - ly);
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
        if (i >= 0) this.rigFor(i)?.wheel(e.deltaY, e.ctrlKey || e.altKey);
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  render(f: MonitorFrame): void {
    const win = this.win;
    if (!win) return;
    if (win.closed) {
      this.dispose();
      return;
    }
    if (win.document !== this.doc || !this.renderer || !this.doc) return;
    (win as unknown as { __rovHeartbeat?: number }).__rovHeartbeat = performance.timeOrigin + performance.now();
    this.lastFrame = performance.now();
    const doc = this.doc;
    const renderer = this.renderer;
    this.msaa = f.msaa;
    const W = Math.max(1, win.innerWidth);
    const H = Math.max(1, win.innerHeight - BAR_H);
    const pr = Math.min(win.devicePixelRatio || 1, f.pixelRatioCap);
    if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
    renderer.getSize(this.size);
    if (this.size.x !== W || this.size.y !== H) renderer.setSize(W, H, false);
    renderer.shadowMap.enabled = f.shadows;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = f.shadows;
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.setScissorTest(true);
    // Clear the whole canvas once (the instrument strip area stays dark).
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.setClearColor(0x05090c, 1);
    renderer.clear();
    const rects = this.rects();
    let instrShown = false;
    for (let i = 0; i < 4; i++) {
      const frame = this.frames[i];
      const r = rects[i];
      const src = this.settings.sources[i];
      if (frame) {
        frame.hidden = !r;
        if (r) Object.assign(frame.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        frame.classList.toggle('active', i === f.active);
      }
      const panelHost = frame?.querySelector('.mp-host') as HTMLElement | null;
      // Sonar
      if (r && src === 'sonar') {
        const sonar = (this.sonars[i] ??= this.makeSonar());
        const el = sonar.canvas;
        if (el.ownerDocument !== doc) doc.adoptNode(el);
        if (el.parentElement !== panelHost) panelHost?.appendChild(el);
        if (f.running) sonar.scanFor(f.dt, f.rovPos, f.heading);
        sonar.draw(r.w, r.h - 30);
      } else this.sonars[i]?.canvas.remove();
      // Instrumentation (one instance per window).
      if (r && src === 'instruments' && !instrShown) {
        instrShown = true;
        this.instr ??= this.instrFactory(doc);
        if (this.instr.root.parentElement !== panelHost) panelHost?.appendChild(this.instr.root);
        if (f.hud) this.instr.update(f.hud, f.hudRef);
      }
      // Camera overlay.
      const camera = !!r && isCameraSource(src);
      if (camera && f.hud && f.hudItems) {
        const ov = (this.overlays[i] ??= new PanelOverlay(doc));
        if (ov.root.parentElement !== frame) frame?.insertBefore(ov.root, frame.firstChild);
        ov.update(f.hud, src, f.camReadout(src), f.hudItems, r.w, r.h);
      } else this.overlays[i]?.root.remove();
      if (!camera) {
        if (this.views[i]?.pass) this.views[i]!.dispose();
        continue;
      }
      let view = this.views[i];
      if (!view || view.source !== src) {
        view?.dispose();
        view = this.views[i] = new SecondaryView(src, this.camStates, f.msaa);
      }
      const vp = glViewport(r, H, pr);
      const pass = view.ensurePass(Math.max(1, Math.round(vp.w * f.scale)), Math.max(1, Math.round(vp.h * f.scale)));
      renderCameraPanel(renderer, view.rig, pass, src, vp, r.w, r.h, f);
      renderer.shadowMap.needsUpdate = false;
    }
    renderer.setScissorTest(false);
    this.stats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    if (!instrShown) this.instr?.root.remove();
    this.updateStrip(f.hud, H);
  }

  private makeSonar(): Sonar {
    const s = new Sonar(this.terrain, this.colliders);
    if (this.sonarCfg) s.configure(this.sonarCfg);
    return s;
  }

  /** Instrument strip (reserved band at the bottom: never over the pictures). */
  private updateStrip(d: HudData | null, top: number): void {
    const strip = this.strip;
    if (!strip) return;
    const mode = this.settings.instruments;
    strip.hidden = mode === 'hidden' || !d;
    strip.dataset.mode = mode;
    if (strip.hidden || !d) return;
    strip.style.top = `${top - STRIP_H[mode]}px`;
    strip.style.height = `${STRIP_H[mode]}px`;
    const now = performance.now();
    if (now - this.stripT < 100) return;
    this.stripT = now;
    strip.innerHTML = instrumentRows(d, mode === 'full')
      .map(([k, v, c]) => `<div${c ? ` class="${c}"` : ''}><span>${k}</span><b>${v}</b></div>`)
      .join('');
  }

  private releaseGpu(): void {
    this.stats = { calls: 0, triangles: 0 };
    this.views.forEach((v, i) => {
      v?.dispose();
      this.views[i] = null;
    });
    this.renderer?.dispose();
    this.renderer = null;
  }

  /** Main window unloading: keep the popup open (it re-attaches itself). */
  unlink(): void {
    this.releaseGpu();
    if (this.win) this.onDetach(this.win);
  }

  dispose(): void {
    this.releaseGpu();
    this.sonars.fill(null);
    this.overlays.fill(null);
    this.instr = null;
    this.frames = [];
    this.strip = null;
    const win = this.win;
    this.win = null;
    this.doc = null;
    if (win) {
      this.onDetach(win);
      if (!win.closed) win.close();
    }
  }
}
