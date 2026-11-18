import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { SettingsStore, type CameraStates, type Settings } from './config/settings';
import { t } from './i18n';
import { InputManager } from './input/inputManager';
import { KeyboardDevice } from './input/keyboard';
import { GamepadDevice } from './input/gamepad';
import { SpaceMouseDevice } from './input/spacemouse/spacemouseDevice';
import type { PilotAction } from './input/types';
import { Simulation } from './sim/simulation';
import { CameraRig } from './render/cameras';
import { UnderwaterPass } from './render/underwaterPass';
import { World } from './render/world';
import { Hud, type GuideData, type HudData } from './ui/hud';
import { launchGuide } from './mission/launchGuide';
import { Menus } from './ui/menus';
import { AudioEngine } from './audio/audio';
import { SITE_BASE_DEPTH, terrainHeight } from './sim/terrain';
import type { Objective } from './mission/types';
import { MISSIONS, missionById } from './mission/catalog';
import { MissionMarkers } from './render/markers';
import { createTmsModel, type TmsModel } from './render/tmsModel';
import { SecondaryView, glViewport, isCameraSource, layoutRects, renderCameraPanel, type PanelEnv } from './render/station';
import { Sonar } from './render/sonar';
import { MonitorWindow } from './render/monitorWindow';
import { PANEL_OVERLAY_CSS, PanelOverlay, type CamReadout } from './ui/panelOverlay';
import { profilePatch, stationOf } from './config/profiles';
import { BUILD, buildLabel, checkPublished, runtimeEnvironment, shortCommit, type PublishedCheck } from './diagnostics/buildInfo';
import { capturedErrors } from './diagnostics/errors';
import { ArrowHelper, BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Points, PointsMaterial } from 'three';
import { DEFAULT_SETTINGS, MAX_MONITORS, type MonitorSettings, type StationProfileId } from './config/settings';
import { InstrumentPanel, StationUi } from './ui/stationUi';
import { Object3D, SpotLight } from 'three';
import type { CameraMode } from './render/cameras';
import { COLLIDERS, INSPECTION_POINTS, LAUNCH_POINT, PIPELINE_PATH } from './sim/site';
import { activeEnvironment, configureEnvironment } from './sim/environment';
import type { ViewSource } from './config/settings';

type AppState = 'menu' | 'running' | 'paused' | 'report';

const PIXEL_RATIO = { low: 1, medium: 1.5, high: 2 } as const;
const MSAA = { low: 0, medium: 2, high: 4 } as const;
const SECONDARY_SCALE = { low: 0.7, medium: 0.85, high: 1 } as const;

export class App {
  private readonly renderer: WebGLRenderer;
  private readonly store = new SettingsStore();
  private readonly input = new InputManager();
  private readonly keyboard: KeyboardDevice;
  private readonly gamepad = new GamepadDevice();
  private readonly spacemouse: SpaceMouseDevice | null;
  private readonly sim: Simulation;
  /** Panel 0 rig (main view). Other panels own their rig in `secondary[i]`. */
  private readonly rig: CameraRig;
  /** Main-menu orbit camera (never touches the station panels). */
  private readonly menuRig: CameraRig;
  /** Pan/tilt/zoom of each physical camera, shared by every panel showing it; persisted. */
  private readonly camStates: CameraStates;
  private camJson = '';
  private camSaveT = 0;
  /**
   * Panel that receives camera commands (keyboard, SpaceMouse buttons, gamepad):
   * window w (0 = main, k+1 = monitor k) and panel p of that window.
   */
  active = { w: 0, p: 0 };
  /** Main-window active panel (compatibility for tests/tools). */
  get activePanel(): number {
    return this.active.w === 0 ? this.active.p : -1;
  }
  set activePanel(p: number) {
    this.active = { w: 0, p };
  }
  private pass: UnderwaterPass;
  private world: World;
  private readonly hud: Hud;
  private readonly menus: Menus;
  private readonly audio = new AudioEngine();
  private state: AppState = 'menu';
  private last = performance.now();
  private time = 0;
  private wet = 0;
  private lastCamUnder = false;
  private fps = 60;
  private menuOrbit = 0;
  private reportShown = false;
  private readonly tmp = new Vector3();
  private readonly camDir = new Vector3();
  /** Draw calls / triangles of the last frame (all passes). */
  frameStats = { calls: 0, triangles: 0, monitorCalls: 0, monitorTriangles: 0, secondaryScale: 1, waterPanels: 0 };
  /** Smoothed measured frame time (ms) and adaptive resolution factor of the secondary views. */
  private frameMs = 16;
  private secAdapt = 1;
  private markers = new MissionMarkers();
  private readonly tetherPts: Vector3[] = [];
  private tmsModel: TmsModel | null = null;
  private tetherLamp: SpotLight | null = null;
  private readonly tmsLamps: SpotLight[] = [];
  private readonly instr = new InstrumentPanel();
  /** Additional monitor windows (index k → "MONITOR k+2"), mirrored from settings.monitors. */
  readonly monitors: MonitorWindow[] = [];
  private monitorJson = '';
  /** Camera overlays of the main-window panels. */
  private readonly overlays: (PanelOverlay | null)[] = [null, null, null, null];
  /** Published-build check (cache vs old code), filled asynchronously at start-up. */
  published: PublishedCheck | null = null;
  /** SpaceMouse/gamepad button latches for the winch (toggle semantics). */
  private tmsLatch = { pay: false, haul: false };
  private readonly secondary: SecondaryView[] = [];
  private sonar!: Sonar;
  private station!: StationUi;
  private mainPassSize = { w: 0, h: 0 };
  /** Fine control latched by a device button (SpaceMouse/gamepad); Shift held also enables it. */
  private fineLatched = false;

  constructor(container: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.className = 'view';
    container.appendChild(canvas);
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.autoClear = true;

    const s = this.store.get();
    // Seabed relief + rock field from the persisted seed, BEFORE the simulation and the
    // scene are built (physics, sonar, tether and rendering share this one environment).
    configureEnvironment({ seed: s.environmentSeed });
    this.environmentSeed = s.environmentSeed;
    this.sim = new Simulation(s.defaultMode);
    this.camStates = structuredClone(s.camState);
    this.camJson = JSON.stringify(this.camStates);
    this.rig = new CameraRig(window.innerWidth / window.innerHeight, this.camStates);
    this.menuRig = new CameraRig(window.innerWidth / window.innerHeight);
    this.menuRig.setMode('external');
    this.pass = this.makePass(s);
    this.world = new World(this.renderer, s.graphics, this.pass);
    this.attachExtras();
    this.configureRenderer(s);

    this.keyboard = new KeyboardDevice(s.bindings);
    // Keys typed while a menu is open go to the menu's form controls, not the ROV.
    this.keyboard.uiActive = () => this.state !== 'running';
    this.input.add(this.keyboard);
    this.input.add(this.gamepad);
    this.spacemouse = SpaceMouseDevice.isSupported() ? new SpaceMouseDevice() : null;
    if (this.spacemouse) {
      const sm = this.spacemouse;
      this.input.add(sm);
      sm.on('connect', () => {
        this.hud?.toast(t('msg.spacemouseConnected', { name: sm.label }), 'ok');
        this.menus?.refreshDevices();
      });
      sm.on('disconnect', () => {
        // Safety: the device's commands vanish immediately (poll() returns no axes
        // when disconnected); the keyboard keeps working. Drop a latched fine mode.
        this.fineLatched = false;
        this.tmsLatch = { pay: false, haul: false };
        this.hud?.toast(t('msg.spacemouseDisconnected'), 'warn', 5000);
        this.menus?.refreshDevices();
      });
      sm.on('stale', () => this.hud?.toast(t('msg.spacemouseStale'), 'warn'));
      sm.on('error', () => this.menus?.refreshDevices());
      // Previously authorised devices reopen without any prompt (browser permission kept).
      void sm.reconnectGranted().catch(() => undefined);
    }
    window.addEventListener('gamepadconnected', () => {
      this.hud?.toast(t('msg.gamepadConnected'), 'ok');
      this.menus?.refreshDevices();
    });
    window.addEventListener('blur', () => {
      this.spacemouse?.releaseAxes();
      this.tmsLatch = { pay: false, haul: false };
      this.hud?.releaseTmsButtons();
    });

    this.hud = new Hud(container);
    const ovCss = document.createElement('style');
    ovCss.textContent = PANEL_OVERLAY_CSS;
    document.head.appendChild(ovCss);
    this.station = new StationUi(container);
    this.station.onSource = (i, src) => {
      this.activePanel = i;
      this.setPanelSource(i, src, true);
    };
    this.station.onLock = (i, locked) => {
      const panelLocks = [...this.store.get().panelLocks];
      panelLocks[i] = locked;
      this.store.update({ panelLocks });
      this.hud.toast(t(locked ? 'station.lockedOn' : 'station.lockedOff', { n: i + 1 }));
    };
    this.station.onActivate = (i) => (this.active = { w: 0, p: i });
    // Sonar sees structures (list) and every physical rock through the shared spatial grid.
    this.sonar = new Sonar(terrainHeight, COLLIDERS, activeEnvironment().grid);
    this.hud.onTmsAction = (a: PilotAction) => this.handleAction(a);
    this.menus = new Menus(container, this.store, MISSIONS, {
      start: (id) => this.start(id),
      resume: () => this.resume(),
      restart: () => this.restart(),
      mainMenu: () => this.toMainMenu(),
      spaceMouse: () => this.spacemouse,
      openMonitor: () => this.openNextMonitor(),
      applyProfile: (id) => this.applyProfile(id),
      saveProfile: () => this.store.update({ customStation: stationOf(this.store.get()), stationProfile: 'custom' }),
      diagnostics: () => this.diagnostics(),
      toggleTetherDebug: () => this.toggleTetherDebug(),
    });
    // The monitor pages adopt themselves on load, after their own reload and after this window's reload.
    (window as unknown as Record<string, unknown>).__rovAdoptMonitor = (w: Window, k: number) => this.monitorAt(k)?.adopt(w);
    window.addEventListener('beforeunload', () => this.monitors.forEach((m) => m.unlink()));
    void checkPublished().then((r) => {
      this.published = r;
      this.menus.setBuildCheck(r);
    });

    this.applySettings(s);
    this.store.subscribe((ns) => this.applySettings(ns));
    this.bindPointer(canvas);
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'running') this.pause();
    });
    this.resize();
    // Expose a read-only handle for automated browser tests.
    (window as unknown as Record<string, unknown>).__ROV__ = { sim: this.sim, app: this, site: { inspectionPoints: INSPECTION_POINTS, pipelinePath: PIPELINE_PATH, rocks: activeEnvironment().rocks } };
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- Lifecycle ----------
  private makePass(s: Settings): UnderwaterPass {
    const pr = Math.min(window.devicePixelRatio || 1, PIXEL_RATIO[s.graphics]);
    return new UnderwaterPass(Math.round(window.innerWidth * pr), Math.round(window.innerHeight * pr), MSAA[s.graphics]);
  }

  private configureRenderer(s: Settings): void {
    this.renderer.shadowMap.enabled = s.graphics !== 'low';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO[s.graphics]));
  }

  private applySettings(s: Settings): void {
    if (s.graphics !== this.world.quality) {
      this.world.dispose();
      this.pass.dispose();
      this.configureRenderer(s);
      this.pass = this.makePass(s);
      this.world = new World(this.renderer, s.graphics, this.pass);
      this.markers = new MissionMarkers();
      this.attachExtras();
      this.secondary.forEach((v) => v.dispose());
      this.mainPassSize = { w: 0, h: 0 };
      this.resize();
    }
    // Water / sediment (shared by every panel and window): the cloud drifts with the
    // simulated current; particle and resuspension amounts are operator settings.
    this.world.setCurrentSampler((p, out) => this.sim.env.current(p, out));
    this.world.setParticleDensity(s.particles);
    this.world.setSedimentStrength(s.sediment);
    this.world.setWaterDetail(s.graphics === 'low' ? 0 : s.graphics === 'medium' ? 1 : 2);
    this.keyboard.setBindings(s.bindings);
    this.keyboard.ramp = s.keyRamp;
    this.gamepad.deadzone = s.gamepadDeadzone;
    this.input.shaping = { sensitivity: s.sensitivity, invert: s.invert, fineGain: 0.35 };
    for (const r of this.allRigs()) {
      r.mouseSensitivity = s.mouseSensitivity;
      r.invertTilt = s.invert.camTilt;
    }
    // Camera states changed from outside (settings reset / another tab): copy in place.
    const cj = JSON.stringify(s.camState);
    if (cj !== this.camJson) {
      copyCamStates(this.camStates, s.camState);
      this.camJson = cj;
    }
    this.sim.setConditionChoice({ current: s.current, visibility: s.visibility, light: s.light, sea: s.sea });
    this.world.setConditions(this.sim.conditions);
    this.audio.setVolume(s.volume);
    this.sim.tether.setBuoyancy(s.tetherBuoyancy);
    // Top-Hat operating depth: fixed, or relative to the seabed under the launch point (clamped to the safe depth by the simulation).
    this.sim.tmsDepth = s.tmsDepthMode === 'seabed' ? -terrainHeight(LAUNCH_POINT.x, LAUNCH_POINT.z) - s.tmsAboveSeabed : s.tmsDepth;
    this.sim.lars.assist = s.dockAssist;
    const mj = JSON.stringify(s.monitors);
    if (mj !== this.monitorJson) {
      this.monitorJson = mj;
      this.syncMonitors(s.monitors);
    }
    this.sonar.configure(s.sonar);
    this.monitors.forEach((m) => m.setSonar(s.sonar));
  }

  private start(missionId = this.store.get().mission): void {
    // Station configuration (layout, panel sources, locks, camera pan/tilt/zoom) is
    // operator setup and survives mission start/restart; only vehicle state resets.
    this.tmsLatch = { pay: false, haul: false };
    this.audio.init();
    if (missionId !== this.store.get().mission) this.store.update({ mission: missionId });
    const def = missionById(missionId);
    this.sim.reset(this.store.get().defaultMode, def);
    this.world.sediment.reset(); // a new operation starts with clear water around the vehicle
    this.world.setConditions(this.sim.conditions);
    this.fineLatched = false;
    this.pass.resetAdaptation();
    this.secondary.forEach((v) => v.pass?.resetAdaptation());
    this.activeTarget();
    this.reportShown = false;
    this.state = 'running';
    this.menus.show(null);
    this.hud.show(true);
    this.keyboard.releaseAll();
  }

  private restart(): void {
    this.start(this.sim.missionDef.id);
  }

  private pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.input.clear();
    this.sim.command.surge = this.sim.command.sway = this.sim.command.heave = this.sim.command.yaw = 0;
    this.menus.show('pause');
    this.audio.suspend(true);
  }

  private resume(): void {
    this.state = 'running';
    this.menus.show(null);
    this.keyboard.releaseAll();
    this.audio.init();
    this.audio.suspend(false);
    this.last = performance.now();
  }

  private toMainMenu(): void {
    this.state = 'menu';
    this.hud.show(false);
    this.sim.reset(this.store.get().defaultMode, missionById('inspection'));
    this.world.sediment.reset();
    this.world.setConditions(this.sim.conditions);
    this.menus.show('main');
    this.audio.suspend(true);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.pass.setSize(Math.round(w * pr), Math.round(h * pr));
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  // ---------- Station panels ----------
  private panelCount(): number {
    return layoutRects(this.store.get().layout, 1, 1).length;
  }

  private allRigs(): CameraRig[] {
    return [this.rig, ...this.secondary.filter(Boolean).map((v) => v.rig)];
  }

  /** Height (CSS px) reserved at the bottom of the main window for the station strip. */
  private stripHeight(): number {
    return this.stationMode() ? this.station.stripHeight : 0;
  }

  /**
   * True when the main window works as a station (2/4 panels, or one panel with
   * sonar/instrumentation): per-panel overlays + reserved strip instead of the
   * full-screen v2 HUD.
   */
  private stationMode(): boolean {
    const st = this.store.get();
    return this.state !== 'menu' && (st.layout !== 'single' || !isCameraSource(st.panels[0]));
  }

  /** Main-window panel rectangles (CSS px), above the reserved station strip. */
  private mainRects() {
    const layout = this.state === 'menu' ? 'single' : this.store.get().layout;
    return layoutRects(layout, window.innerWidth, Math.max(1, window.innerHeight - this.stripHeight()));
  }

  /** Index of the main-window panel under a client point (-1: none, e.g. the strip). */
  private panelAt(x: number, y: number): number {
    return this.mainRects().findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }

  private monitorAt(k: number): MonitorWindow | null {
    return this.monitors[k] ?? null;
  }

  /** Create/remove MonitorWindow objects to match settings.monitors (open windows are kept). */
  private syncMonitors(list: MonitorSettings[]): void {
    while (this.monitors.length > list.length) this.monitors.pop()!.dispose();
    list.forEach((m, k) => {
      let w = this.monitors[k];
      if (!w) {
        w = this.monitors[k] = new MonitorWindow(k, terrainHeight, COLLIDERS, (doc) => new InstrumentPanel(doc), this.camStates, structuredClone(m));
        w.setSonar(this.store.get().sonar);
        w.onChange = (ms) => {
          const monitors = structuredClone(this.store.get().monitors);
          monitors[k] = structuredClone(ms);
          this.store.update({ monitors, stationProfile: 'custom' });
        };
        // Keys typed in a monitor window drive the same (single) keyboard device.
        w.onAttach = (win) => this.keyboard.attachWindow(win);
        w.onDetach = (win) => this.keyboard.detachWindow(win);
        w.onActivate = (p) => (this.active = { w: k + 1, p });
      } else w.setSettings(structuredClone(m));
    });
  }

  /** F8 / menu: open the next configured monitor window that is not open yet (one per user action). */
  private openNextMonitor(): boolean {
    if (this.monitors.length === 0) {
      const monitors = [...this.store.get().monitors, structuredClone(DEFAULT_SETTINGS.monitors[0])].slice(0, MAX_MONITORS);
      this.store.update({ monitors });
    }
    const next = this.monitors.find((m) => !m.isOpen) ?? this.monitors[this.monitors.length - 1];
    const ok = !!next && next.open();
    if (!ok) this.hud.toast(t('settings.monitorBlocked'), 'warn', 5000);
    else if (this.monitors.every((m) => m.isOpen) || next === this.monitors[this.monitors.length - 1]) this.hud.toast(t('msg.monitorOpened', { n: next.index + 2 }), 'ok');
    return ok;
  }

  private applyProfile(id: StationProfileId): boolean {
    const patch = profilePatch(id, this.store.get());
    if (!patch) return false;
    this.store.update(patch);
    this.active = { w: 0, p: 0 };
    this.hud.toast(t('msg.profileApplied', { p: t('profile.' + id) }), 'ok');
    return true;
  }

  /** Sources / locks / panel count of window w (0 = main). */
  private windowPanels(w: number): { sources: ViewSource[]; locks: boolean[]; count: number } | null {
    const st = this.store.get();
    if (w === 0) return { sources: st.panels, locks: st.panelLocks, count: this.panelCount() };
    const m = st.monitors[w - 1];
    if (!m || !this.monitors[w - 1]?.isOpen) return null;
    return { sources: m.sources, locks: m.locks, count: layoutRects(m.layout, 1, 1).length };
  }

  /** Active target, validated (falls back to main panel 0 if its window closed or the layout shrank). */
  private activeTarget(): { w: number; p: number } {
    const wp = this.windowPanels(this.active.w);
    if (!wp) this.active = { w: 0, p: 0 };
    else if (this.active.p >= wp.count) this.active = { w: this.active.w, p: wp.count - 1 };
    return this.active;
  }

  /** Camera rig of panel i of the main window (null when the panel shows sonar/instruments). */
  rigFor(i: number): CameraRig | null {
    const src = this.store.get().panels[i];
    if (!isCameraSource(src)) return null;
    if (i === 0) return this.rig;
    const v = (this.secondary[i] ??= this.makeView(src));
    if (v.source !== src) v.setSource(src);
    return v.rig;
  }

  /** Rig of the active target, in whichever window it is. */
  private activeRig(): CameraRig | null {
    const a = this.activeTarget();
    return a.w === 0 ? this.rigFor(a.p) : (this.monitors[a.w - 1]?.rigFor(a.p) ?? null);
  }

  private makeView(src: ViewSource): SecondaryView {
    const v = new SecondaryView(src, this.camStates, Math.min(2, MSAA[this.store.get().graphics]));
    v.rig.mouseSensitivity = this.store.get().mouseSensitivity;
    v.rig.invertTilt = this.store.get().invert.camTilt;
    return v;
  }

  /**
   * Change the source of panel p of window w. Implicit changes (shortcuts,
   * SpaceMouse, gamepad) are refused on a locked panel; explicit ones come
   * from the panel selector.
   */
  setPanelSource(p: number, src: ViewSource, explicit = false, w = 0): boolean {
    const st = this.store.get();
    const wp = this.windowPanels(w);
    if (!wp) return false;
    const label = w === 0 ? `${p + 1}` : `M${w + 1}·${p + 1}`;
    if (!explicit && wp.locks[p]) {
      this.hud.toast(t('station.lockedRefused', { n: label }), 'warn');
      return false;
    }
    if (wp.sources[p] === src) return true;
    if (w === 0) {
      const panels = [...st.panels];
      panels[p] = src;
      this.store.update({ panels, stationProfile: 'custom' });
      if (p === 0) this.pass.resetAdaptation();
      else this.secondary[p]?.pass?.resetAdaptation();
    } else {
      const monitors = structuredClone(st.monitors);
      monitors[w - 1].sources[p] = src;
      this.store.update({ monitors, stationProfile: 'custom' });
    }
    return true;
  }

  /** Camera shortcut / device button: put a camera on the active panel (if unlocked). */
  private selectCamera(m: CameraMode): void {
    const a = this.activeTarget();
    if (!this.setPanelSource(a.p, m, false, a.w)) return;
    this.sim.mission.notifyCameraToggled();
    const n = this.windowPanels(a.w)?.count ?? 1;
    const label = a.w === 0 ? `${a.p + 1}` : `M${a.w + 1}·${a.p + 1}`;
    this.hud.toast(n > 1 || a.w > 0 ? t('msg.cameraPanel', { c: t('view.' + m), n: label }) : t('msg.camera', { c: t('view.' + m) }));
  }

  /** Source currently shown in the active panel. */
  private activeSource(): ViewSource {
    const a = this.activeTarget();
    return this.windowPanels(a.w)?.sources[a.p] ?? this.store.get().panels[0];
  }

  /** Camera head readout for overlays (from the shared physical-camera state). */
  private camReadout = (src: ViewSource): CamReadout | null => (isCameraSource(src) ? { ...this.camStates[src] } : null);

  /** Secondary-view resolution factor (quantised to avoid reallocating targets every frame). */
  private secScale(): number {
    return Math.round(this.secAdapt * 4) / 4;
  }

  /** Persist camera pan/tilt/zoom (throttled; only when changed). */
  private saveCamStates(force = false): void {
    if (!force && this.time - this.camSaveT < 1) return;
    this.camSaveT = this.time;
    const j = JSON.stringify(this.camStates);
    if (j === this.camJson) return;
    this.store.update({ camState: structuredClone(this.camStates) });
    copyCamStates(this.camStates, this.store.get().camState);
    this.camJson = JSON.stringify(this.camStates);
  }

  /**
   * Mouse acts on the panel under the pointer: a press selects it as the active
   * panel and the drag stays bound to it (dragging panel 3 never moves panel 1).
   */
  private bindPointer(canvas: HTMLCanvasElement): void {
    let dragPanel = -1;
    let lx = 0;
    let ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragPanel = this.panelAt(e.clientX, e.clientY);
      if (this.state === 'running' && dragPanel >= 0) this.active = { w: 0, p: dragPanel };
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragPanel < 0 || this.state !== 'running') return;
      this.rigFor(dragPanel)?.drag(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = () => (dragPanel = -1);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.state !== 'running') return;
        // Wheel = tilt (as in v2); Ctrl/Alt + wheel = zoom. External view: distance.
        const i = this.panelAt(e.clientX, e.clientY);
        if (i >= 0) this.rigFor(i)?.wheel(e.deltaY, e.ctrlKey || e.altKey);
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- Actions ----------
  private handleAction(a: PilotAction): void {
    const sim = this.sim;
    switch (a) {
      case 'pause':
        if (this.state === 'running') this.pause();
        else if (this.state === 'paused' && this.menus.current === 'pause') this.resume();
        return;
      case 'help':
        if (this.state === 'running') {
          this.pause();
          this.menus.show('help');
        } else if (this.menus.current === 'help') this.menus.back();
        return;
    }
    if (this.state !== 'running') return;
    switch (a) {
      case 'toggleLights':
        sim.lightsOn = !sim.lightsOn;
        this.hud.toast(sim.lightsOn ? t('msg.lights', { v: Math.round(sim.lightLevel * 100) }) : t('msg.lightsOff'));
        break;
      case 'lightsUp':
      case 'lightsDown': {
        sim.lightsOn = true;
        sim.lightLevel = Math.min(1, Math.max(0.1, Math.round((sim.lightLevel + (a === 'lightsUp' ? 0.1 : -0.1)) * 10) / 10));
        this.hud.toast(t('msg.lights', { v: Math.round(sim.lightLevel * 100) }));
        break;
      }
      case 'toggleCamera': {
        // Operational ⇄ external on the active panel (as in v2), if not locked.
        this.selectCamera(this.activeSource() === 'operational' ? 'external' : 'operational');
        break;
      }
      case 'camTiltCenter': {
        const r = this.activeRig();
        if (r && r.mode === 'operational') r.tilt = 0;
        else if (r && r.mode === 'auxiliary') r.auxTilt = 0;
        else if (r && r.mode === 'tether') r.tetherTilt = 0;
        break;
      }
      case 'cycleMode':
        this.modeToast(sim.cycleMode());
        break;
      case 'modeManual':
      case 'modeStabilize':
      case 'modeDepthHold': {
        const mode = a === 'modeManual' ? 'manual' : a === 'modeStabilize' ? 'stabilize' : 'depthHold';
        sim.setMode(mode);
        this.modeToast(mode);
        break;
      }
      case 'fineControl':
        this.fineLatched = !this.fineLatched;
        this.hud.toast(t(this.fineLatched ? 'msg.fineOn' : 'msg.fineOff'));
        break;
      case 'toggleHud':
        this.hud.toast(t('msg.hud.' + this.hud.cycleDensity()));
        break;
      case 'camAux':
      case 'camOp':
      case 'camExt':
      case 'camTms':
      case 'camTether': {
        const m = ({ camOp: 'operational', camAux: 'auxiliary', camExt: 'external', camTms: 'tms', camTether: 'tether' } as const)[a];
        this.selectCamera(m);
        break;
      }
      case 'monitorOpen':
        this.openNextMonitor();
        return;
      case 'layoutCycle': {
        const order = ['single', 'dual', 'quad'] as const;
        const next = order[(order.indexOf(this.store.get().layout) + 1) % order.length];
        this.store.update({ layout: next });
        this.hud.toast(t('msg.layout.' + next));
        break;
      }
      case 'toggleGuide': {
        const order = ['expanded', 'compact', 'hidden'] as const;
        const next = order[(order.indexOf(this.store.get().guide) + 1) % order.length];
        this.store.update({ guide: next });
        this.hud.toast(t('guide.mode.' + next));
        break;
      }
      case 'tmsRecover': {
        // Free mode only (missions drive launch/recovery themselves).
        if (sim.missionDef.id !== 'free') {
          this.hud.toast(t('msg.recover.missionOnly'), 'warn');
          break;
        }
        const r = sim.toggleAssembly();
        this.hud.toast(t(r ? 'msg.recover.' + r : 'msg.recover.dockFirst'), r ? 'ok' : 'warn', 4000);
        break;
      }
      case 'tmsAuto':
        sim.tms.reset(sim.tms.payout, sim.tms.mode === 'auto' ? 'manual' : 'auto');
        this.tmsLatch = { pay: false, haul: false };
        this.hud.toast(t('msg.tms.' + sim.tms.mode));
        break;
      case 'tetherStop':
        this.tmsLatch = { pay: false, haul: false };
        this.hud.releaseTmsButtons();
        sim.tms.command = 'stop';
        if (sim.tms.mode === 'auto') sim.tms.reset(sim.tms.payout, 'manual');
        break;
      case 'tetherPay':
        this.tmsLatch = { pay: !this.tmsLatch.pay, haul: false };
        break;
      case 'tetherHaul':
        this.tmsLatch = { pay: false, haul: !this.tmsLatch.haul };
        break;
      case 'confirm': {
        // Release from the Top-Hat when latched at depth (except during recovery).
        if (sim.lars.state === 'atDepth' && sim.releaseRov()) {
          this.audio.click();
          this.hud.toast(t('lars.releasedToast'), 'ok', 4000);
          break;
        }
        const res = sim.mission.confirm();
        if (res) {
          this.audio.click();
          this.hud.toast(this.objectiveText(res), 'ok', 4000);
        }
        break;
      }
    }
  }

  private modeToast(mode: string): void {
    this.hud.toast(t('msg.mode', { m: t(`hud.mode.${mode}`) }));
    if (mode === 'depthHold' && this.sim.rov.submerged < 0.95) this.hud.toast(t('msg.depthHoldSurface'), 'warn');
  }

  // ---------- Frame ----------
  private frame(): void {
    const now = performance.now();
    const realMs = now - this.last;
    const dt = Math.min(0.1, realMs / 1000);
    this.last = now;
    this.time += dt;
    // Measured (unclamped) frame rate / time.
    this.fps += (1000 / Math.max(realMs, 1) - this.fps) * 0.05;
    this.frameMs += (Math.min(realMs, 1000) - this.frameMs) * 0.05;

    const actions = this.input.poll();
    for (const a of actions) this.handleAction(a);
    // TMS winch: hold-to-run from keyboard / HUD buttons, toggle from device buttons.
    {
      const live = this.state === 'running';
      const pay = live && (this.keyboard.held('tetherPay') || this.hud.tmsHeld.pay || this.tmsLatch.pay);
      const haul = live && (this.keyboard.held('tetherHaul') || this.hud.tmsHeld.haul || this.tmsLatch.haul);
      if ((pay || haul) && this.sim.tms.mode === 'auto') {
        this.sim.tms.reset(this.sim.tms.payout, 'manual');
        this.hud.toast(t('msg.tms.manual'));
      }
      this.sim.tms.setCommand(pay, haul);
      if (live) {
        // Camera commands act on the active panel's camera (allowed even when locked).
        const ar = this.activeRig();
        const z = (this.keyboard.held('zoomIn') ? 1 : 0) - (this.keyboard.held('zoomOut') ? 1 : 0);
        if (z) ar?.adjustZoom(z * dt * 8);
        const p = (this.keyboard.held('camPan+') ? 1 : 0) - (this.keyboard.held('camPan-') ? 1 : 0);
        if (p) ar?.panBy(p * 40 * dt);
      }
    }
    // Fine control: Shift held, or latched by a device button.
    this.input.fine = this.keyboard.held('fineControl') || this.fineLatched;

    const sim = this.sim;
    const running = this.state === 'running';
    if (running) {
      const c = this.input.command;
      Object.assign(sim.command, c);
      this.activeRig()?.tiltBy(c.camTilt * 40 * dt);
      const ev = sim.advance(dt);
      for (const imp of ev.impacts) {
        this.audio.knock(imp.speed);
        this.hud.toast(
          t('mission.collision', { what: t(`mission.what.${imp.kind}`), v: imp.speed.toFixed(2) }),
          imp.speed >= 1 ? 'alarm' : 'warn',
        );
      }
      if (ev.splash !== 0) this.audio.splash();
      if (ev.released && this.sim.missionDef.start === 'crane') this.hud.toast(t('mission.launch.released'), 'ok', 4000);
      if (ev.docked) {
        this.audio.knock(0.15);
        this.hud.toast(t('lars.dockedToast'), 'ok', 5000);
      }
    }

    // Sync the visual vehicle with the physics state.
    const rov = this.world.rov;
    rov.root.position.copy(sim.rov.position);
    rov.root.quaternion.copy(sim.rov.orientation);
    rov.cameraTilt.rotation.z = (this.rig.tilt * Math.PI) / 180;
    rov.root.updateMatrixWorld(true);
    const levels = sim.rov.params.thrusters.map((_, i) => sim.rov.thrusters.level(i));
    rov.setThrust(levels, running ? dt : 0);

    // Cameras: in the main menu a separate rig slowly orbits the vehicle on the crane.
    const menu = this.state === 'menu';
    if (menu) {
      this.menuOrbit += dt * 0.08;
      this.menuRig.orbitYaw = 2.2 + Math.sin(this.menuOrbit) * 0.6;
      this.menuRig.orbitPitch = 0.12;
      this.menuRig.orbitDist = 7;
    }
    const st = this.store.get();
    if (isCameraSource(st.panels[0]) && st.panels[0] !== this.rig.mode) this.rig.setMode(st.panels[0] as CameraMode);
    const rig0 = menu ? this.menuRig : this.rig;
    const headingRad = (sim.rov.heading * Math.PI) / 180;
    rig0.tmsMount = this.tmsModel?.cameraMount ?? null;
    rig0.update(dt, rov.root, rov.cameraEye, headingRad);
    const cam = rig0.camera;

    // Mission (uses the operational camera geometry even when viewing externally).
    rov.cameraEye.getWorldPosition(this.tmp);
    this.rig.operationalDirection(rov.cameraEye, this.camDir);
    if (running) {
      sim.updateMission(dt, {
        cameraPosition: { x: this.tmp.x, y: this.tmp.y, z: this.tmp.z },
        cameraDirection: { x: this.camDir.x, y: this.camDir.y, z: this.camDir.z },
        cameraMode: this.operationalVisible() ? 'operational' : 'external',
      });
      if (sim.mission.complete && !this.reportShown) {
        this.reportShown = true;
        this.state = 'report';
        this.hud.show(false);
        this.menus.showReport(sim.missionDef, sim.mission, this.conditionsLabel());
      }
    }
    this.markers.update(this.state === 'menu' ? [] : sim.mission.markers());
    this.world.setSeabedDisturbance(sim.rov.seabedDisturbance, sim.rov.position);

    // Environment & effects.
    const camDepth = -cam.position.y;
    // Observer-mode light: a non-physical visual aid used ONLY while rendering
    // external views (set per panel below), never for the operational cameras.
    const obs = this.world.observerLight;
    const lighting = st.lighting;
    const assisted = lighting.observer === 'assisted';
    const observer = (mode: string, pos: Vector3) => {
      obs.position.copy(pos);
      obs.intensity = assisted && mode === 'external' && pos.y < -8 ? 60 : 0;
    };
    const camUnder = camDepth > 0;
    if (camUnder !== this.lastCamUnder) {
      this.wet = 1;
      this.lastCamUnder = camUnder;
    }
    this.wet = Math.max(0, this.wet - dt * 0.6);
    const ambient = this.world.updateEnvironment({
      rovDepth: sim.rov.depth,
      camDepth,
      time: this.time,
      camPos: cam.position,
      lightLevel: sim.effectiveLight,
    });
    // Main umbilical: crane sheave → Top-Hat termination (always attached).
    this.world.vessel.setWire(sim.lars.liftWorld(this.tmp));
    this.world.updateTether(dt, sim.crane === 'released' ? sim.tether.polyline(16, this.tetherPts) : null);
    this.world.updateSeabed(sim.rov.position);
    // The sediment cloud evolves only while the operation runs (frozen when paused / in menus).
    this.world.sedimentRunning = running;
    this.updateTetherDebug();
    const seabedDepth = -terrainHeight(cam.position.x, cam.position.z) || SITE_BASE_DEPTH;
    // TMS visuals follow the winch state.
    if (this.tmsModel) {
      this.tmsModel.root.position.copy(sim.lars.position);
      this.tmsModel.root.rotation.y = sim.lars.yaw;
      const tms = sim.tms;
      this.tmsModel.setDrumAngle(tms.drumAngle);
      this.tmsModel.setStoredFraction(tms.storedFraction);
      const ph = (tms.payout / 6) % 2;
      this.tmsModel.setLevelWind(ph < 1 ? ph * 2 - 1 : 3 - ph * 2);
    }
    // Top/aft lamp of the ROV (tether termination + first metres) and the TMS lamps.
    if (this.tetherLamp) {
      this.tetherLamp.intensity = 30 * lighting.top * sim.effectiveLight;
      this.tetherLamp.visible = this.tetherLamp.intensity > 0;
    }
    for (const l of this.tmsLamps) l.intensity = 30 * lighting.tms;
    this.world.frontGain = lighting.front;
    this.world.setTetherAssist(lighting.tetherAssist);
    const fx = st.cameraFx;
    // Observer (external) camera, assisted: +0.6 EV on that view only.
    const fxExt = assisted ? { ...fx, exposureBias: fx.exposureBias + 0.6 } : fx;
    const fxFor = (mode: string) => (mode === 'external' ? fxExt : fx);
    const wbFor = (depth: number) => Math.min(1, Math.max(0, (depth - 25) / 40)) * (sim.effectiveLight > 0 ? 1 : 0.35);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const pr = this.renderer.getPixelRatio();
    // Main-window panels sit above the reserved station strip (multi-panel layouts).
    const rects = this.mainRects();
    const src0: ViewSource = menu ? 'external' : st.panels[0];
    const act = this.activeTarget();
    const hosts = this.station.layout(rects, st.panels, st.panelLocks, act.w === 0 ? act.p : -1, menu ? 'single' : st.layout);
    const stationMode = this.stationMode();
    this.hud.root.dataset.layout = stationMode ? (st.layout === 'single' ? 'dual' : st.layout) : 'single';
    // One environment for every camera panel of every window (single simulation).
    const env: PanelEnv = {
      world: this.world,
      dt,
      time: this.time,
      rovRoot: rov.root,
      eye: rov.cameraEye,
      headingRad,
      tmsMount: this.tmsModel?.cameraMount ?? null,
      terrainHeight,
      fxFor,
      whiteBalance: wbFor,
      observer,
      ambient,
      lightLevel: sim.effectiveLight,
      seabedBase: SITE_BASE_DEPTH,
    };
    void seabedDepth;
    const info = this.renderer.info;
    info.autoReset = false;
    info.reset();
    this.world.panelDraws = 0;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setScissorTest(true);
    if (rects.length > 0 && rects[0].y + rects[0].h < H) {
      // Clear the strip band (it is DOM, but keep the canvas below it dark).
      this.renderer.setViewport(0, 0, W, H);
      this.renderer.setScissor(0, 0, W, H);
      this.renderer.setClearColor(0x05090c, 1);
      this.renderer.clear();
    }
    let sonarHost: HTMLElement | null = null;
    let sonarRect: { w: number; h: number } | null = null;
    let instrHost: HTMLElement | null = null;
    let instrRect: { w: number; h: number } | null = null;
    const multi = rects.length > 1;
    const hudData = this.hud.lastData;
    const secK = SECONDARY_SCALE[st.graphics] * this.secScale();

    for (let i = 0; i < rects.length; i++) {
      const src = i === 0 ? src0 : st.panels[i];
      const r = rects[i];
      // Operational overlay over camera panels (multi-panel layouts; the single
      // layout keeps the full v2 HUD instead).
      const ov = this.overlays[i];
      if (multi && isCameraSource(src) && hudData && this.state !== 'report') {
        const o = (this.overlays[i] ??= new PanelOverlay(document));
        if (o.root.parentElement !== this.station.frame(i)) this.station.frame(i)?.prepend(o.root);
        o.update(hudData, src, this.camReadout(src), st.hudItems, r.w, r.h);
      } else ov?.root.remove();
      if (src === 'sonar') {
        if (!sonarHost) {
          sonarHost = hosts[i];
          sonarRect = r;
        }
        continue;
      }
      if (src === 'instruments') {
        if (!instrHost) {
          instrHost = hosts[i];
          instrRect = r;
        }
        continue;
      }
      const vp = glViewport(r, H, pr);
      if (i === 0) {
        // Panel 1: full-resolution MSAA pass (and the lens "wet" transition).
        if (vp.w !== this.mainPassSize.w || vp.h !== this.mainPassSize.h) {
          this.pass.setSize(vp.w, vp.h);
          this.mainPassSize = { w: vp.w, h: vp.h };
        }
        renderCameraPanel(this.renderer, rig0, this.pass, src0, vp, r.w, r.h, env, this.wet);
      } else {
        const view = (this.secondary[i] ??= this.makeView(src));
        if (view.source !== src) view.setSource(src);
        const sp = view.ensurePass(Math.max(1, Math.round(vp.w * secK)), Math.max(1, Math.round(vp.h * secK)));
        renderCameraPanel(this.renderer, view.rig, sp, src, vp, r.w, r.h, env);
      }
      this.renderer.shadowMap.needsUpdate = false;
    }
    for (let i = rects.length; i < this.overlays.length; i++) this.overlays[i]?.root.remove();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, W, H);
    // Free the render targets of panels that are hidden or show sonar/instruments
    // (their rig — camera orientation — is kept).
    for (let i = 1; i < this.secondary.length; i++) {
      const v = this.secondary[i];
      if (v?.pass && (i >= rects.length || !isCameraSource(st.panels[i]))) v.dispose();
    }
    if (running) this.saveCamStates();
    // Sonar: scan the real geometry only while it is visible.
    if (sonarHost && sonarRect) {
      if (this.sonar.canvas.parentElement !== sonarHost) sonarHost.appendChild(this.sonar.canvas);
      if (running) this.sonar.scanFor(dt, sim.rov.position, sim.rov.heading);
      this.sonar.draw(sonarRect.w, sonarRect.h - 30);
    } else if (this.sonar.canvas.parentElement) this.sonar.canvas.remove();
    // Monitor windows (same simulation, same frame, same panel renderer).
    let monCalls = 0;
    let monTris = 0;
    this.monitors.forEach((m, k) => {
      if (!m.isOpen) return;
      m.render({
        ...env,
        running,
        rovPos: sim.rov.position,
        heading: sim.rov.heading,
        scale: secK,
        pixelRatioCap: PIXEL_RATIO[st.graphics],
        msaa: Math.min(2, MSAA[st.graphics]),
        shadows: st.graphics !== 'low',
        active: act.w === k + 1 ? act.p : -1,
        hud: hudData,
        hudRef: this.hud,
        hudItems: st.hudItems,
        camReadout: this.camReadout,
      });
      monCalls += m.stats.calls;
      monTris += m.stats.triangles;
    });
    // Instrumentation panel.
    if (instrHost && instrRect && hudData) {
      if (this.instr.root.parentElement !== instrHost) instrHost.appendChild(this.instr.root);
      this.instr.update(hudData, this.hud);
    } else if (this.instr.root.parentElement) this.instr.root.remove();
    // Station strip (reserved band under the panels in multi-panel layouts).
    if (hudData) this.station.updateStrip(hudData, stationMode);
    // Graceful degradation: with several views, lower the secondary views' resolution
    // (in 25 % steps) while frames are slow, and restore it when there is headroom.
    const anyMonitor = this.monitors.some((m) => m.isOpen);
    if (running && (rects.length > 1 || anyMonitor)) {
      if (this.frameMs > 40) this.secAdapt = Math.max(0.5, this.secAdapt - dt * 0.1);
      else if (this.frameMs < 24) this.secAdapt = Math.min(1, this.secAdapt + dt * 0.05);
    }
    this.frameStats = { calls: info.render.calls, triangles: info.render.triangles, monitorCalls: monCalls, monitorTriangles: monTris, secondaryScale: this.secScale(), waterPanels: this.world.panelDraws };

    // Audio & HUD.
    const load = levels.reduce((s, l) => s + Math.abs(l), 0) / levels.length;
    this.audio.update(load, camUnder, cam.position.distanceTo(sim.rov.position));
    if (this.state === 'running' || this.state === 'paused') this.hud.update(this.hudData(), dt);
  }

  private objectiveText(o: Objective): string {
    const params = { ...(o.params ?? {}) };
    if (typeof params.label === 'string') params.label = t(params.label);
    return t(o.key, params);
  }

  /** True if the ROV pilot camera is visible in any station panel. */
  private operationalVisible(): boolean {
    const st = this.store.get();
    if (st.panels.slice(0, this.panelCount()).includes('operational')) return true;
    return this.monitors.some((m, k) => m.isOpen && st.monitors[k]?.sources.slice(0, layoutRects(st.monitors[k].layout, 1, 1).length).includes('operational'));
  }

  /** TMS model, its lamp and the main umbilical (re-attached when the World is rebuilt). */
  private attachExtras(): void {
    const scene = this.world.scene;
    scene.add(this.markers.group);
    this.tmsModel = createTmsModel({ quality: this.store.get().graphics });
    const m = this.tmsModel;
    m.root.position.copy(this.sim.lars.position);
    m.root.rotation.y = this.sim.lars.yaw;
    scene.add(m.root);
    // TMS mechanism lamps (both mounts): light the drum, level wind and exit guide
    // for the TMS camera at any depth. Powered by the TMS, independent of ROV lights.
    this.tmsLamps.length = 0;
    for (const mount of m.lightMounts) {
      const lamp = new SpotLight(0xfff2d8, 30, 0, (60 * Math.PI) / 180, 0.6, 2);
      const target = new Object3D();
      target.position.set(0, 0, -5);
      mount.add(lamp, target);
      lamp.target = target;
      this.tmsLamps.push(lamp);
    }
    // Top/aft lamp on the ROV, aimed aft/up along the tether termination and first metres.
    const tl = new SpotLight(0xf3f0e8, 0, 0, (70 * Math.PI) / 180, 0.7, 2);
    const tt = new Object3D();
    tl.position.set(0.2, 1.2, 0);
    tt.position.set(-4, 3.4, 0);
    this.world.rov.root.add(tl, tt);
    tl.target = tt;
    this.tetherLamp = tl;
  }

  // ---------- Diagnostics ----------
  private tetherDebug: { group: Group; points: Points; line: Line; arrow: ArrowHelper } | null = null;

  /** Engineering view of the tether: physical nodes (red = in contact), segments and attach force. */
  toggleTetherDebug(): boolean {
    if (this.tetherDebug) {
      this.tetherDebug.group.removeFromParent();
      this.tetherDebug.points.geometry.dispose();
      this.tetherDebug = null;
      return false;
    }
    const n = this.sim.tether.debugState().nodes.length;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
    const points = new Points(geo, new PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, depthTest: false }));
    const line = new Line(geo, new LineBasicMaterial({ color: 0x40e0ff, depthTest: false }));
    const arrow = new ArrowHelper(new Vector3(1, 0, 0), new Vector3(), 1, 0xff4040);
    const group = new Group();
    group.add(points, line, arrow);
    group.renderOrder = 999;
    this.world.scene.add(group);
    this.tetherDebug = { group, points, line, arrow };
    return true;
  }

  private updateTetherDebug(): void {
    const d = this.tetherDebug;
    if (!d) return;
    const tt = this.sim.tether.debugState();
    const pos = d.points.geometry.getAttribute('position') as BufferAttribute;
    const col = d.points.geometry.getAttribute('color') as BufferAttribute;
    tt.nodes.forEach((p, i) => {
      if (i >= pos.count) return;
      pos.setXYZ(i, p.x, p.y, p.z);
      const c = tt.nodeContact[i];
      col.setXYZ(i, c ? 1 : 0.3, c ? 0.2 : 1, c ? 0.2 : 0.4);
    });
    pos.needsUpdate = col.needsUpdate = true;
    d.points.geometry.computeBoundingSphere();
    d.group.visible = this.sim.crane === 'released';
    const f = tt.attachForce;
    const mag = f.length();
    if (mag > 1) {
      this.sim.attachWorld(this.tmp);
      d.arrow.position.copy(this.tmp);
      d.arrow.setDirection(this.tmp.copy(f).normalize());
      d.arrow.setLength(Math.min(6, 0.5 + mag / 500), 0.3, 0.15);
      d.arrow.visible = true;
    } else d.arrow.visible = false;
  }

  /** Seed the running environment was built with (a changed setting applies on restart). */
  private environmentSeed = 0;

  /** Last visual checks observed during the preparation (for the guide). */
  private guideChecks = { lights: false, thrusters: false, camera: false };

  /** Operational launch guide from the real simulation state (null when hidden or finished). */
  private guideData(): GuideData | null {
    const mode = this.store.get().guide;
    if (mode === 'hidden') return null;
    const sim = this.sim;
    const prep = sim.mission.prepChecklist();
    if (prep) this.guideChecks = { ...prep };
    const crane = sim.missionDef.start === 'crane';
    const st = this.store.get();
    const view = launchGuide({
      lars: sim.lars.state,
      launchAuthorised: !crane || prep === null,
      checks: crane ? this.guideChecks : { lights: true, thrusters: true, camera: true },
      stationArranged: st.layout !== 'single' || this.monitors.some((w) => w.isOpen),
      tmsDepth: -sim.lars.position.y,
      tmsTargetDepth: sim.lars.depth,
      payout: sim.tms.payout,
      chord: sim.tether.chordLength,
    });
    if (view.complete) return null;
    const steps = view.steps.map((s, i) => ({
      label: t('guide.s.' + s.id),
      detail: s.detail ? t(s.detail.key, s.detail.params) : null,
      hint: i === view.current ? t('guide.h.' + s.id) : null,
      done: s.done,
      optional: s.optional,
      current: i === view.current,
    }));
    return { mode, index: view.current + 1, total: steps.length, steps };
  }

  /** Plain-text report for the diagnostics screen (and to paste into a bug report). */
  diagnostics(): string {
    const st = this.store.get();
    const sim = this.sim;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'n/d';
    let stored = 'n/d';
    try {
      stored = String(JSON.parse(localStorage.getItem('rov.settings.v1') ?? '{}').version ?? 'sem versão (anterior à 3.1.1)');
    } catch {
      stored = 'ilegível';
    }
    const pub = this.published;
    const pubTxt = !pub
      ? 'verificando…'
      : pub.state === 'same'
        ? `igual ao publicado (${shortCommit(pub.published.commit)})`
        : pub.state === 'newer'
          ? `DESATUALIZADO: publicado v${pub.published.version} ${shortCommit(pub.published.commit)} (${pub.published.builtAt}) — recarregue a página`
          : `indisponível (${pub.reason})`;
    const a = this.activeTarget();
    const mons = st.monitors
      .map((m, k) => {
        const w = this.monitors[k];
        const age = w?.isOpen ? `${Math.round(performance.now() - w.lastFrame)} ms desde o último quadro` : 'fechado';
        return `  M${k + 2}: ${m.layout} [${m.sources.slice(0, layoutRects(m.layout, 1, 1).length).join(', ')}] faixa=${m.instruments} — ${age}`;
      })
      .join('\n');
    const tt = sim.tether.debugState();
    const f = tt.attachForce;
    const lines = [
      '== BUILD ==',
      `${buildLabel()}  (${BUILD.builder}${BUILD.ref ? ' ' + BUILD.ref : ''})`,
      `commit completo: ${BUILD.commit}`,
      `ambiente: ${runtimeEnvironment()}  ·  ${location.href.split('?')[0]}`,
      `versão publicada: ${pubTxt}`,
      `configurações: esquema salvo ${stored} → atual ${st.version}`,
      `ambiente: semente ${this.environmentSeed}${st.environmentSeed !== this.environmentSeed ? ' — ' + t('diag.seedPending', { s: st.environmentSeed, c: this.environmentSeed }) : ''} · rochas físicas ${activeEnvironment().rocks.length} · tiles ${JSON.stringify(this.world.seabed.stats)}`,
      `GPU: ${gpu}`,
      '',
      '== DESEMPENHO ==',
      `FPS ${this.fps.toFixed(1)} · quadro ${this.frameMs.toFixed(1)} ms · draw calls ${this.frameStats.calls} (+${this.frameStats.monitorCalls} monitores) · triângulos ${this.frameStats.triangles} · escala secundária ${this.frameStats.secondaryScale}`,
      '',
      '== ESTAÇÃO ==',
      `perfil ${st.stationProfile} · layout ${st.layout} [${st.panels.slice(0, this.panelCount()).join(', ')}] · fixos ${st.panelLocks.map((l) => (l ? 'F' : 'L')).join('')}`,
      `painel ativo: ${a.w === 0 ? 'principal' : 'M' + (a.w + 1)} #${a.p + 1} (${this.activeSource()})`,
      mons || '  (nenhum monitor adicional configurado)',
      '',
      '== ENTRADA ==',
      `fontes ativas: ${JSON.stringify(this.input.sources)} · fino ${this.input.fine}`,
      `SpaceMouse: ${!this.spacemouse ? 'WebHID indisponível' : this.spacemouse.connected() ? this.spacemouse.label : 'desconectado'} · gamepads: ${navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean).length : 0}`,
      '',
      '== SIMULAÇÃO ==',
      `estado ${this.state} · missão ${sim.missionDef.id} · modo ${sim.controller.mode}`,
      `ROV prof ${sim.rov.depth.toFixed(2)} m · rumo ${sim.rov.heading.toFixed(1)}° · pitch ${sim.rov.pitch.toFixed(1)}° · roll ${sim.rov.roll.toFixed(1)}° · alt ${sim.altitude?.toFixed(2) ?? '---'} m`,
      `Top-Hat ${sim.lars.state} a ${(-sim.lars.position.y).toFixed(1)} m · TMS ${sim.tms.mode}/${sim.tms.state} · pago ${sim.tms.payout.toFixed(1)} m · v ${sim.tms.speed.toFixed(2)} m/s`,
      `tether: tração ${tt.tension.toFixed(0)} N · folga ${tt.slack.toFixed(1)} m · corda ${tt.chord.toFixed(1)} m · força na terminação (${f.x.toFixed(0)}, ${f.y.toFixed(0)}, ${f.z.toFixed(0)}) N · contatos fundo/estr./ROV ${tt.contacts.seabed}/${tt.contacts.structure}/${tt.contacts.rov}`,
      '',
      `== ERROS (${capturedErrors.length}) ==`,
      ...(capturedErrors.length ? capturedErrors.map((e) => `${e.time} [${e.kind}] ${e.message}`) : ['nenhum']),
    ];
    return lines.join('\n');
  }

  /** Docking guidance when the ROV is free and within 15 m of the Top-Hat. */
  private dockInfo() {
    const sim = this.sim;
    if (sim.lars.state !== 'released') return null;
    const rec = sim.lars.receptacleWorld(new Vector3());
    const distance = rec.distanceTo(sim.rov.position);
    if (distance > 15) return null;
    const c = sim.lars.lastCapture ?? sim.lars.checkCapture(sim.rov.position, sim.rov.orientation, sim.rov.worldVelocity(), sim.rov.heading, sim.tms.payout);
    return { ...c, distance, assist: sim.lars.assist };
  }

  private conditionsLabel(): string {
    const c = this.sim.conditions.choice;
    return [`${t('settings.current')}: ${t('settings.current.' + c.current)}`, `${t('settings.visibility')}: ${t('settings.visibility.' + c.visibility)}`, `${t('settings.light')}: ${t('settings.light.' + c.light)}`, `${t('settings.sea')}: ${t('settings.sea.' + c.sea)}`].join(' · ');
  }

  private hudData(): HudData {
    const sim = this.sim;
    const rov = sim.rov;
    const m = sim.mission;
    const st = sim.controller.status();
    const vw = rov.worldVelocity(new Vector3());
    const alt = sim.altitude;
    const geom = m.targetGeometry();
    const bank = rov.thrusters as unknown as { load?(i: number): number; powerFraction?: number };
    const showHints = this.store.get().showHints;
    const hint = showHints ? m.hint(null) : null;
    const navLabel = m.navTargetLabel();
    return {
      depth: rov.depth,
      depthSetpoint: st.depthSetpoint,
      verticalSpeed: vw.y,
      heading: rov.heading,
      headingSetpoint: st.headingSetpoint,
      pitch: rov.pitch,
      roll: rov.roll,
      altitude: rov.depth > 0.5 ? alt : null,
      dvl: alt !== null && alt < 90 && rov.depth > 1 ? { surge: rov.velocity.x, sway: rov.velocity.z } : null,
      thrusterIds: rov.params.thrusters.map((x) => x.id),
      thrusterLevels: rov.params.thrusters.map((_, i) => rov.thrusters.level(i)),
      thrusterLoads: typeof bank.load === 'function' ? rov.params.thrusters.map((_, i) => bank.load!(i)) : null,
      saturation: st.saturation ?? 1,
      larsState: sim.lars.state,
      dock: this.dockInfo(),
      tms: {
        mode: sim.tms.mode,
        state: sim.tms.state,
        payout: sim.tms.payout,
        stored: sim.tms.stored,
        speed: sim.tms.speed,
        tension: sim.tether.tension,
        slack: sim.tether.slack,
        tensionWarn: sim.tms.config.tensionWarn,
        tensionLimit: sim.tms.config.tensionLimit,
        slackWarn: sim.tms.config.slackWarn,
        maxLength: sim.tms.config.maxLength,
        onRov: sim.tether.contacts.rov > 0,
        released: sim.crane === 'released',
      },
      tetherAtMax: sim.tms.payout >= sim.tms.config.maxLength - 0.01,
      powerFraction: typeof bank.powerFraction === 'number' ? bank.powerFraction : null,
      command: this.input.raw,
      sources: this.input.sources,
      spacemouse: !this.spacemouse ? 'unsupported' : this.spacemouse.connected() ? 'on' : 'off',
      fine: this.input.fine,
      mode: st.mode,
      camera: this.rig.mode,
      tilt: this.rig.tilt,
      lightsOn: sim.lightsOn,
      lightLevel: sim.lightLevel,
      diveTime: m.stats.startTime === null ? null : m.time - m.stats.startTime,
      tether: sim.tetherOut(),
      crane: sim.crane,
      contacts: rov.contactCount,
      steps: m.steps(),
      stepIndex: m.stepIndex(),
      stageLabel: t(m.stageKey()),
      objective:
        sim.lars.state === 'atDepth' && sim.missionDef.start !== 'crane' ? t('lars.releasePrompt') : this.objectiveText(m.objective()),
      hint: hint ? this.objectiveText(hint) : null,
      checklist: m.prepChecklist(),
      guide: this.guideData(),
      holdProgress: m.holdProgress(),
      range: geom ? geom.range : null,
      offAxis: geom ? geom.offAxis : null,
      warning: m.warning ? this.objectiveText(m.warning) : null,
      position: { x: rov.position.x, y: rov.position.y, z: rov.position.z },
      navTarget: m.navTarget(),
      targetLabel: navLabel,
      fps: this.store.get().showFps ? this.fps : null,
    };
  }
}

function copyCamStates(dst: CameraStates, src: CameraStates): void {
  for (const k of Object.keys(dst) as (keyof CameraStates)[]) Object.assign(dst[k], src[k]);
}
