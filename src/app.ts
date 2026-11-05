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
import { Hud, type HudData } from './ui/hud';
import { Menus } from './ui/menus';
import { AudioEngine } from './audio/audio';
import { SITE_BASE_DEPTH, terrainHeight } from './sim/terrain';
import type { Objective } from './mission/types';
import { MISSIONS, missionById } from './mission/catalog';
import { MissionMarkers } from './render/markers';
import { createTmsModel, type TmsModel } from './render/tmsModel';
import { SecondaryView, glViewport, isCameraSource, layoutRects, usePanel } from './render/station';
import { Sonar } from './render/sonar';
import { SecondaryWindow } from './render/secondaryWindow';
import { InstrumentPanel, StationUi } from './ui/stationUi';
import { Object3D, SpotLight } from 'three';
import type { CameraMode } from './render/cameras';
import { COLLIDERS, INSPECTION_POINTS } from './sim/site';
import type { ViewSource } from './config/settings';

type AppState = 'menu' | 'running' | 'paused' | 'report';

const PIXEL_RATIO = { low: 1, medium: 1.5, high: 2 } as const;
const MSAA = { low: 0, medium: 2, high: 4 } as const;

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
  /** Panel that receives camera commands (keyboard, SpaceMouse buttons, gamepad). */
  activePanel = 0;
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
  frameStats = { calls: 0, triangles: 0 };
  private markers = new MissionMarkers();
  private readonly tetherPts: Vector3[] = [];
  private tmsModel: TmsModel | null = null;
  private tetherLamp: SpotLight | null = null;
  private readonly tmsLamps: SpotLight[] = [];
  private readonly instr = new InstrumentPanel();
  private readonly monitor2: SecondaryWindow;
  private monitorJson = '';
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
    this.sim = new Simulation(s.defaultMode);
    this.camStates = structuredClone(s.camState);
    this.camJson = JSON.stringify(this.camStates);
    this.rig = new CameraRig(window.innerWidth / window.innerHeight, this.camStates);
    this.menuRig = new CameraRig(window.innerWidth / window.innerHeight);
    this.menuRig.setMode('external');
    this.monitor2 = new SecondaryWindow(terrainHeight, COLLIDERS, (doc) => new InstrumentPanel(doc), this.camStates, structuredClone(s.monitor));
    this.monitorJson = JSON.stringify(s.monitor);
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
    this.station.onActivate = (i) => (this.activePanel = i);
    this.sonar = new Sonar(terrainHeight, COLLIDERS);
    this.hud.onTmsAction = (a: PilotAction) => this.handleAction(a);
    this.menus = new Menus(container, this.store, MISSIONS, {
      start: (id) => this.start(id),
      resume: () => this.resume(),
      restart: () => this.restart(),
      mainMenu: () => this.toMainMenu(),
      spaceMouse: () => this.spacemouse,
      openMonitor: () => this.monitor2.open(),
    });
    this.monitor2.onChange = (m) => {
      this.monitorJson = JSON.stringify(m);
      this.store.update({ monitor: structuredClone(m) });
    };
    // Keys typed in the monitor window drive the same (single) keyboard device.
    this.monitor2.onAttach = (w) => this.keyboard.attachWindow(w);
    this.monitor2.onDetach = (w) => this.keyboard.detachWindow(w);
    // The monitor page adopts itself on load, after its own reload and after this window's reload.
    (window as unknown as Record<string, unknown>).__rovAdoptMonitor = (w: Window) => this.monitor2.adopt(w);
    window.addEventListener('beforeunload', () => this.monitor2.unlink());

    this.applySettings(s);
    this.store.subscribe((ns) => this.applySettings(ns));
    this.bindPointer(canvas);
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'running') this.pause();
    });
    this.resize();
    // Expose a read-only handle for automated browser tests.
    (window as unknown as Record<string, unknown>).__ROV__ = { sim: this.sim, app: this, site: { inspectionPoints: INSPECTION_POINTS } };
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
    this.sim.tmsDepth = s.tmsDepth;
    this.sim.lars.assist = s.dockAssist;
    const mj = JSON.stringify(s.monitor);
    if (mj !== this.monitorJson) {
      this.monitorJson = mj;
      this.monitor2.setSettings(structuredClone(s.monitor));
    }
    this.sonar.configure(s.sonar);
    this.monitor2.setSonar(s.sonar);
  }

  private start(missionId = this.store.get().mission): void {
    // Station configuration (layout, panel sources, locks, camera pan/tilt/zoom) is
    // operator setup and survives mission start/restart; only vehicle state resets.
    this.tmsLatch = { pay: false, haul: false };
    this.audio.init();
    if (missionId !== this.store.get().mission) this.store.update({ mission: missionId });
    const def = missionById(missionId);
    this.sim.reset(this.store.get().defaultMode, def);
    this.world.setConditions(this.sim.conditions);
    this.fineLatched = false;
    this.pass.resetAdaptation();
    this.secondary.forEach((v) => v.pass?.resetAdaptation());
    this.activePanel = Math.min(this.activePanel, this.panelCount() - 1);
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

  /** Index of the panel under a client point (current layout). */
  private panelAt(x: number, y: number): number {
    const rects = layoutRects(this.store.get().layout, window.innerWidth, window.innerHeight);
    const i = rects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    return Math.max(0, i);
  }

  /** Camera rig of panel i (null when the panel shows sonar/instruments). */
  rigFor(i: number): CameraRig | null {
    const src = this.store.get().panels[i];
    if (!isCameraSource(src)) return null;
    if (i === 0) return this.rig;
    const v = (this.secondary[i] ??= this.makeView(src));
    if (v.source !== src) v.setSource(src);
    return v.rig;
  }

  private makeView(src: ViewSource): SecondaryView {
    const v = new SecondaryView(src, this.camStates);
    v.rig.mouseSensitivity = this.store.get().mouseSensitivity;
    v.rig.invertTilt = this.store.get().invert.camTilt;
    return v;
  }

  private activeIndex(): number {
    return Math.min(this.activePanel, this.panelCount() - 1);
  }

  /**
   * Change a panel's source. Implicit changes (shortcuts, SpaceMouse, gamepad)
   * are refused on a locked panel; explicit ones come from the panel selector.
   */
  setPanelSource(i: number, src: ViewSource, explicit = false): boolean {
    const st = this.store.get();
    if (!explicit && st.panelLocks[i]) {
      this.hud.toast(t('station.lockedRefused', { n: i + 1 }), 'warn');
      return false;
    }
    if (st.panels[i] === src) return true;
    const panels = [...st.panels];
    panels[i] = src;
    this.store.update({ panels });
    if (i === 0) this.pass.resetAdaptation();
    else this.secondary[i]?.pass?.resetAdaptation();
    return true;
  }

  /** Camera shortcut / device button: put a camera on the active panel (if unlocked). */
  private selectCamera(m: CameraMode): void {
    const i = this.activeIndex();
    if (!this.setPanelSource(i, m)) return;
    this.sim.mission.notifyCameraToggled();
    const n = this.panelCount();
    this.hud.toast(n > 1 ? t('msg.cameraPanel', { c: t('view.' + m), n: i + 1 }) : t('msg.camera', { c: t('view.' + m) }));
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
      if (this.state === 'running') this.activePanel = dragPanel;
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
        this.rigFor(this.panelAt(e.clientX, e.clientY))?.wheel(e.deltaY, e.ctrlKey || e.altKey);
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
        const cur = this.store.get().panels[this.activeIndex()];
        this.selectCamera(cur === 'operational' ? 'external' : 'operational');
        break;
      }
      case 'camTiltCenter': {
        const r = this.rigFor(this.activeIndex());
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
        if (!this.monitor2.open()) this.hud.toast(t('settings.monitorBlocked'), 'warn', 5000);
        return;
      case 'layoutCycle': {
        const order = ['single', 'dual', 'quad'] as const;
        const next = order[(order.indexOf(this.store.get().layout) + 1) % order.length];
        this.store.update({ layout: next });
        this.hud.toast(t('msg.layout.' + next));
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
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

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
        const ar = this.rigFor(this.activeIndex());
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
      this.rigFor(this.activeIndex())?.tiltBy(c.camTilt * 40 * dt);
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
    const rects = layoutRects(menu ? 'single' : st.layout, W, H);
    const src0: ViewSource = menu ? 'external' : st.panels[0];
    const active = this.activeIndex();
    const hosts = this.station.layout(rects, st.panels, st.panelLocks, active);
    this.hud.root.dataset.layout = menu ? 'single' : st.layout;
    const info = this.renderer.info;
    info.autoReset = false;
    info.reset();
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setScissorTest(true);
    let sonarHost: HTMLElement | null = null;
    let sonarRect: { w: number; h: number } | null = null;
    let instrHost: HTMLElement | null = null;
    let instrRect: { w: number; h: number } | null = null;

    for (let i = 0; i < rects.length; i++) {
      const src = i === 0 ? src0 : st.panels[i];
      const r = rects[i];
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
        // Main (interactive) view: full pipeline incl. particles/beams.
        if (vp.w !== this.mainPassSize.w || vp.h !== this.mainPassSize.h) {
          this.pass.setSize(vp.w, vp.h);
          this.mainPassSize = { w: vp.w, h: vp.h };
        }
        cam.aspect = r.w / r.h;
        cam.updateProjectionMatrix();
        usePanel(this.renderer, vp);
        observer(rig0.mode, cam.position);
        this.pass.setCameraFx(fxFor(src0), rig0.mode === 'operational');
        this.pass.update(cam, { camDepth, seabedDepth, time: this.time, wet: this.wet, whiteBalance: wbFor(camDepth) });
        this.world.effects.update(cam, {
          time: this.time,
          width: vp.w,
          height: vp.h,
          originX: vp.x,
          originY: vp.y,
          pixelRatio: pr,
          ambient,
          underwater: camUnder,
          lightLevel: sim.effectiveLight,
        });
        this.pass.render(this.renderer, this.world.scene, cam);
        this.renderer.autoClear = false;
        this.renderer.render(this.world.effects.scene, cam);
        this.renderer.autoClear = true;
      } else {
        // Secondary views (shared simulation & scene; no particle overlay).
        const view = (this.secondary[i] ??= this.makeView(src));
        if (view.source !== src) view.setSource(src);
        const sp = view.ensurePass(Math.round(vp.w * 0.75), Math.round(vp.h * 0.75));
        sp.setWater(this.pass.optics);
        view.rig.tmsMount = this.tmsModel?.cameraMount ?? null;
        view.rig.camera.aspect = r.w / r.h;
        view.rig.update(dt, rov.root, rov.cameraEye, headingRad);
        const vc = view.rig.camera;
        const d = -vc.position.y;
        observer(view.rig.mode, vc.position);
        sp.setCameraFx(fxFor(src), src === 'operational' || src === 'auxiliary');
        sp.update(vc, { camDepth: d, seabedDepth: -terrainHeight(vc.position.x, vc.position.z) || SITE_BASE_DEPTH, time: this.time, wet: 0, whiteBalance: wbFor(d) });
        usePanel(this.renderer, vp);
        sp.render(this.renderer, this.world.scene, vc);
      }
      this.renderer.shadowMap.needsUpdate = false;
    }
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
      if (running) this.sonar.scan(sim.rov.position, sim.rov.heading);
      this.sonar.draw(sonarRect.w, sonarRect.h - 22);
    } else if (this.sonar.canvas.parentElement) this.sonar.canvas.remove();
    // Secondary monitor window (same simulation, same frame).
    this.monitor2.render({
      scene: this.world.scene,
      dt,
      time: this.time,
      rovRoot: rov.root,
      eye: rov.cameraEye,
      headingRad,
      tmsMount: this.tmsModel?.cameraMount ?? null,
      mainPass: this.pass,
      fxFor,
      terrainHeight,
      whiteBalance: wbFor,
      observer,
      rovPos: sim.rov.position,
      heading: sim.rov.heading,
      running,
    });
    if (this.hud.lastData) {
      this.monitor2.instruments?.update(this.hud.lastData, this.hud);
      this.monitor2.updateBar(this.hud.lastData);
    }
    // Instrumentation panel.
    if (instrHost && instrRect && this.hud.lastData) {
      if (this.instr.root.parentElement !== instrHost) instrHost.appendChild(this.instr.root);
      this.instr.update(this.hud.lastData, this.hud);
    } else if (this.instr.root.parentElement) this.instr.root.remove();
    this.frameStats = { calls: info.render.calls, triangles: info.render.triangles };

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
    return this.store.get().panels.slice(0, this.panelCount()).includes('operational');
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
