import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from 'three';
import { SettingsStore, type Settings } from './config/settings';
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
import { LAUNCH_POINT } from './sim/site';
import type { Objective } from './mission/types';
import { MISSIONS, missionById } from './mission/catalog';
import { MissionMarkers } from './render/markers';
import type { EnvironmentConditions } from './sim/conditions';
import type { CameraFx } from './config/settings';

/** Optional v2 render hooks (provided by World / UnderwaterPass when available). */
interface WorldV2 {
  setConditions?(c: EnvironmentConditions): void;
  setSeabedDisturbance?(amount: number, position: Vector3): void;
}
interface PassV2 {
  setCameraFx?(fx: CameraFx, operational: boolean): void;
}

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
  private readonly rig: CameraRig;
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
  private readonly bufSize = new Vector2();
  private markers = new MissionMarkers();
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
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.pass = this.makePass(s);
    this.world = new World(this.renderer, s.graphics, this.pass);
    this.world.scene.add(this.markers.group);
    this.configureRenderer(s);

    this.keyboard = new KeyboardDevice(s.bindings);
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
    window.addEventListener('blur', () => this.spacemouse?.releaseAxes());

    this.hud = new Hud(container);
    this.menus = new Menus(container, this.store, MISSIONS, {
      start: (id) => this.start(id),
      resume: () => this.resume(),
      restart: () => this.restart(),
      mainMenu: () => this.toMainMenu(),
      spaceMouse: () => this.spacemouse,
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
    (window as unknown as Record<string, unknown>).__ROV__ = { sim: this.sim, app: this };
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
      this.world.scene.add(this.markers.group);
      this.resize();
    }
    this.keyboard.setBindings(s.bindings);
    this.keyboard.ramp = s.keyRamp;
    this.gamepad.deadzone = s.gamepadDeadzone;
    this.input.shaping = { sensitivity: s.sensitivity, invert: s.invert, fineGain: 0.35 };
    this.rig.mouseSensitivity = s.mouseSensitivity;
    this.rig.invertTilt = s.invert.camTilt;
    this.sim.setConditionChoice({ current: s.current, visibility: s.visibility, light: s.light, sea: s.sea });
    (this.world as WorldV2).setConditions?.(this.sim.conditions);
    this.audio.setVolume(s.volume);
  }

  private start(missionId = this.store.get().mission): void {
    this.audio.init();
    if (missionId !== this.store.get().mission) this.store.update({ mission: missionId });
    const def = missionById(missionId);
    this.sim.reset(this.store.get().defaultMode, def);
    (this.world as WorldV2).setConditions?.(this.sim.conditions);
    this.fineLatched = false;
    this.rig.setMode(def.start === 'crane' ? 'external' : 'operational');
    this.rig.tilt = def.start === 'crane' ? -10 : -22;
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
    (this.world as WorldV2).setConditions?.(this.sim.conditions);
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

  private bindPointer(canvas: HTMLCanvasElement): void {
    let dragging = false;
    let lx = 0;
    let ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || this.state !== 'running') return;
      this.rig.drag(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = () => (dragging = false);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.state === 'running') this.rig.wheel(e.deltaY);
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
        const m = this.rig.toggle();
        sim.mission.notifyCameraToggled();
        this.hud.toast(t('msg.camera', { c: t(m === 'operational' ? 'hud.cam.op' : 'hud.cam.ext') }));
        break;
      }
      case 'camTiltCenter':
        this.rig.tilt = 0;
        break;
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
      case 'confirm': {
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
    // Fine control: Shift held, or latched by a device button.
    this.input.fine = this.keyboard.held('fineControl') || this.fineLatched;

    const sim = this.sim;
    const running = this.state === 'running';
    if (running) {
      const c = this.input.command;
      Object.assign(sim.command, c);
      this.rig.adjustTilt(c.camTilt * 40 * dt);
      const ev = sim.advance(dt);
      for (const imp of ev.impacts) {
        this.audio.knock(imp.speed);
        this.hud.toast(
          t('mission.collision', { what: t(`mission.what.${imp.kind}`), v: imp.speed.toFixed(2) }),
          imp.speed >= 1 ? 'alarm' : 'warn',
        );
      }
      if (ev.splash !== 0) this.audio.splash();
      if (ev.released) this.hud.toast(t('mission.launch.released'), 'ok', 4000);
    }

    // Sync the visual vehicle with the physics state.
    const rov = this.world.rov;
    rov.root.position.copy(sim.rov.position);
    rov.root.quaternion.copy(sim.rov.orientation);
    rov.cameraTilt.rotation.z = (this.rig.tilt * Math.PI) / 180;
    rov.root.updateMatrixWorld(true);
    const levels = sim.rov.params.thrusters.map((_, i) => sim.rov.thrusters.level(i));
    rov.setThrust(levels, running ? dt : 0);

    // Cameras: in the main menu, slowly orbit the vehicle on the crane.
    if (this.state === 'menu') {
      this.menuOrbit += dt * 0.08;
      this.rig.setMode('external');
      this.rig.orbitYaw = 2.2 + Math.sin(this.menuOrbit) * 0.6;
      this.rig.orbitPitch = 0.12;
      this.rig.orbitDist = 7;
    }
    const headingRad = (sim.rov.heading * Math.PI) / 180;
    this.rig.update(dt, rov.root, rov.cameraEye, headingRad);
    const cam = this.rig.camera;

    // Mission (uses the operational camera geometry even when viewing externally).
    rov.cameraEye.getWorldPosition(this.tmp);
    this.rig.operationalDirection(rov.cameraEye, this.camDir);
    if (running) {
      sim.updateMission(dt, {
        cameraPosition: { x: this.tmp.x, y: this.tmp.y, z: this.tmp.z },
        cameraDirection: { x: this.camDir.x, y: this.camDir.y, z: this.camDir.z },
        cameraMode: this.rig.mode,
      });
      if (sim.mission.complete && !this.reportShown) {
        this.reportShown = true;
        this.state = 'report';
        this.hud.show(false);
        this.menus.showReport(sim.missionDef, sim.mission, this.conditionsLabel());
      }
    }
    this.markers.update(this.state === 'menu' ? [] : sim.mission.markers());
    (this.world as WorldV2).setSeabedDisturbance?.((sim.rov as unknown as { seabedDisturbance?: number }).seabedDisturbance ?? 0, sim.rov.position);

    // Environment & effects.
    const camDepth = -cam.position.y;
    // Observer light only for the external view at depth (not part of the vehicle).
    const obs = this.world.observerLight;
    obs.position.copy(cam.position);
    obs.intensity = this.rig.mode === 'external' && camDepth > 15 ? 45 : 0;
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
    this.world.vessel.setWire(sim.wireEnd() ? this.tmp.copy(rov.tetherPoint.getWorldPosition(new Vector3())) : null);
    this.world.updateTether(
      dt,
      sim.crane === 'released' ? new Vector3(LAUNCH_POINT.x, 1.5, LAUNCH_POINT.z) : null,
      sim.rov.waterVelocity,
    );
    const seabedDepth = -terrainHeight(cam.position.x, cam.position.z) || SITE_BASE_DEPTH;
    const opCam = this.rig.mode === 'operational';
    const fx = this.store.get().cameraFx;
    const passV2 = this.pass as PassV2;
    if (passV2.setCameraFx) passV2.setCameraFx(fx, opCam);
    else this.pass.setNoise(opCam ? 0.035 * fx.noise * 2.5 : 0.012, opCam ? 0.55 * fx.vignette * 2 : 0.25);
    // Camera white balance follows the artificial lighting once sunlight has faded.
    const wb = Math.min(1, Math.max(0, (camDepth - 25) / 40)) * (sim.effectiveLight > 0 ? 1 : 0.35);
    this.pass.update(cam, { camDepth, seabedDepth, time: this.time, wet: this.wet, whiteBalance: wb });
    const size = this.renderer.getDrawingBufferSize(this.bufSize);
    this.world.effects.update(cam, {
      time: this.time,
      width: size.x,
      height: size.y,
      pixelRatio: this.renderer.getPixelRatio(),
      ambient,
      underwater: camUnder,
      lightLevel: sim.effectiveLight,
    });

    // Render: scene → underwater composite → particles/beams.
    const info = this.renderer.info;
    info.autoReset = false;
    info.reset();
    this.pass.render(this.renderer, this.world.scene, cam);
    this.renderer.autoClear = false;
    this.renderer.render(this.world.effects.scene, cam);
    this.renderer.autoClear = true;
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
      tetherAtMax: sim.crane === 'released' && sim.tether.atMaxLength,
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
      objective: this.objectiveText(m.objective()),
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
