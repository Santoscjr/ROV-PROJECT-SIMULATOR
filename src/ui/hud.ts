import { t } from '../i18n';
import type { PilotMode } from '../control/rovController';
import type { MissionStep } from '../mission/types';
import { JUMPER_PATH, MANIFOLD, PIPELINE_PATH, PLET, TREE, VESSEL, type V3 } from '../sim/site';
import type { CameraMode } from '../render/cameras';
import type { CraneState } from '../sim/simulation';
import type { AxisCommand, AxisName, PilotAction } from '../input/types';
import './hud.css';

export interface HudData {
  depth: number;
  depthSetpoint: number | null;
  verticalSpeed: number;
  heading: number;
  headingSetpoint: number | null;
  pitch: number;
  roll: number;
  altitude: number | null;
  /** Speed over ground from the DVL (null without bottom lock). */
  dvl: { surge: number; sway: number } | null;
  thrusterIds: string[];
  thrusterLevels: number[];
  command: AxisCommand;
  fine: boolean;
  mode: PilotMode;
  camera: CameraMode;
  tilt: number;
  lightsOn: boolean;
  lightLevel: number;
  diveTime: number | null;
  tether: number;
  crane: CraneState;
  contacts: number;
  steps: MissionStep[];
  stepIndex: number;
  stageLabel: string;
  objective: string;
  hint: string | null;
  /** SpaceMouse connection: on, off (supported, not connected), unsupported. */
  spacemouse: 'on' | 'off' | 'unsupported';
  /** Which device drives each axis right now. */
  sources: Partial<Record<AxisName, string>>;
  /** Total propulsion power as a fraction of the budget (null if not modelled). */
  powerFraction: number | null;
  /** Per-thruster load 0..1 of max power (optional). */
  thrusterLoads: number[] | null;
  /** Fraction of the demanded wrench actually delivered (1 = not saturated). */
  saturation: number;
  /** Umbilical at maximum paid-out length (winch limit). */
  tetherAtMax: boolean;
  /** Docking guidance (released and near the Top-Hat), from the capture check. */
  dock: { horizontal: number; vertical: number; headingError: number; relSpeed: number; payout: number; ok: boolean; distance: number; assist: boolean } | null;
  /** Launch & recovery state label key. */
  larsState: string;
  tms: {
    mode: 'manual' | 'auto';
    state: string;
    payout: number;
    stored: number;
    speed: number;
    tension: number;
    slack: number;
    tensionWarn: number;
    tensionLimit: number;
    slackWarn: number;
    maxLength: number;
    onRov: boolean;
    released: boolean;
  };
  checklist: { lights: boolean; thrusters: boolean; camera: boolean } | null;
  holdProgress: number | null;
  range: number | null;
  offAxis: number | null;
  warning: string | null;
  position: V3;
  navTarget: V3 | null;
  targetLabel: string | null;
  fps: number | null;
}

const fmt = (v: number, d = 1) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const pad3 = (v: number) => String(Math.round(((v % 360) + 360) % 360) % 360).padStart(3, '0');
const cardinal = (v: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((v % 360) + 360) % 360) / 45) % 8];
const hms = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const COLORS = {
  line: 'rgba(223,232,238,0.9)',
  dim: 'rgba(125,141,153,0.9)',
  accent: '#f2a93b',
  data: '#6cc4d8',
  ok: '#5fbf7a',
  warn: '#e0a03a',
  sky: 'rgba(40,90,120,0.55)',
  ground: 'rgba(90,70,40,0.55)',
};

function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const r = c.getBoundingClientRect();
  // Hidden HUD/panel (zero size): nothing to draw — avoids negative arc radii.
  if (r.width < 8 || r.height < 8) return null;
  const ctx = c.getContext('2d')!;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return ctx;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly el: Record<string, HTMLElement> = {};
  private headingCanvas!: HTMLCanvasElement;
  private depthCanvas!: HTMLCanvasElement;
  private attCanvas!: HTMLCanvasElement;
  private navCanvas!: HTMLCanvasElement;
  private reticle!: SVGSVGElement;
  private bars: HTMLElement[] = [];
  private cmdEls: Record<string, { box: HTMLElement; fill: HTMLElement }> = {};
  private textTimer = 0;
  /** Last data (used by the instrumentation panel source). */
  lastData: HudData | null = null;
  private navRange = 80;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="panel status">
        <div class="ptitle"><span>WC-150</span><span data-k="clock"></span></div>
        <div class="kv"><span class="k">${t('hud.mode')}</span><span class="v mode" data-k="mode"></span></div>
        <div class="kv"><span class="k">${t('hud.camera')}</span><span class="v" data-k="camera"></span></div>
        <div class="kv"><span class="k">${t('hud.lights')}</span><span class="v" data-k="lights"></span></div>
        <div class="kv"><span class="k">${t('hud.speed')}</span><span class="v" data-k="speed"></span></div>
        <div class="kv"><span class="k">${t('hud.diveTime')}</span><span class="v" data-k="time"></span></div>
        <div class="kv"><span class="k">${t('hud.tether')}</span><span class="v" data-k="tether"></span></div>
        <div class="kv"><span class="k">${t('hud.input')}</span><span class="v" data-k="input"></span></div>
      </div>
      <div class="panel heading"><canvas data-c="heading"></canvas></div>
      <div class="panel depth"><canvas data-c="depth"></canvas></div>
      <div class="panel attitude">
        <canvas data-c="att"></canvas>
        <div class="readouts">
          <div><span class="k">${t('hud.pitch')}</span><span data-k="pitch"></span></div>
          <div><span class="k">${t('hud.roll')}</span><span data-k="roll"></span></div>
        </div>
        <div class="alt">
          <div class="ptitle" style="padding:0"><span>${t('hud.altitude')}</span><span data-k="contact"></span></div>
          <div class="big" data-k="alt"></div>
          <div class="sub"><span>${t('hud.vspeed')}</span><span data-k="vs"></span></div>
        </div>
      </div>
      <div class="panel mission">
        <div class="ptitle"><span>${t('hud.mission')}</span><span data-k="stageIdx"></span></div>
        <div class="stages" data-k="stages"></div>
        <div class="stage-name" data-k="stage"></div>
        <div class="objective" data-k="objective"></div>
        <ul class="checklist" data-k="checklist"></ul>
        <div class="geom" data-k="geom"></div>
        <div class="progress" data-k="progressBox"><i data-k="progress"></i></div>
        <div class="warning" data-k="warning"></div>
        <div class="mhint" data-k="hint"></div>
      </div>
      <div class="panel thrust">
        <div class="ptitle"><span>${t('hud.thrust')}</span><span><span data-k="limit" class="lim"></span> <span data-k="fine"></span></span></div>
        <div class="bars" data-k="bars"></div>
        <div class="power" data-k="powerBox"><span>${t('hud.power')}</span><div class="h"><i data-k="power"></i></div><b data-k="powerTxt"></b></div>
        <div class="ptitle" style="padding-top:8px"><span>${t('hud.command')}</span><span data-k="srcs"></span></div>
        <div class="cmds" data-k="cmds"></div>
      </div>
      <div class="panel nav">
        <div class="ptitle"><span>${t('hud.nav')}</span><span data-k="navRange"></span></div>
        <canvas data-c="nav"></canvas>
        <div class="navinfo"><span>${t('hud.brg')} <b data-k="brg">---</b></span><span>${t('hud.dist')} <b data-k="dist">---</b></span></div>
      </div>
      <svg class="reticle" viewBox="0 0 120 120" data-k="reticle">
        <g stroke="rgba(235,242,246,0.85)" stroke-width="1.2" fill="none">
          <path d="M60 44v10M60 66v10M44 60h10M66 60h10"/>
          <path d="M20 32v-12h12M88 20h12v12M100 88v12H88M32 100H20V88" stroke="rgba(242,169,59,0.75)"/>
        </g>
        <circle cx="60" cy="60" r="26" stroke="#5fbf7a" stroke-width="2.5" fill="none" data-k="ring"
          stroke-dasharray="0 999" transform="rotate(-90 60 60)"/>
      </svg>
      <div class="panel tmsp">
        <div class="tms-line"><b class="tl">TETHER</b><span data-k="tmsPayout"></span><span data-k="tmsMode" class="st"></span><span data-k="tmsSpeed"></span><span data-k="tmsTension"></span><span data-k="tmsSlack"></span></div>
        <div class="tms-bar"><i data-k="tmsLen"></i></div>
        <div class="tms-line dock" data-k="dockLine"></div>
        <div class="tms-warn" data-k="tmsWarn"></div>
      </div>
      <div class="ibar" data-k="ibar"></div>
      <div class="toasts" data-k="toasts"></div>
      <div class="osd" data-k="osd"></div>
      <div class="fps" data-k="fps"></div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.headingCanvas = this.root.querySelector('[data-c="heading"]')!;
    this.depthCanvas = this.root.querySelector('[data-c="depth"]')!;
    this.attCanvas = this.root.querySelector('[data-c="att"]')!;
    this.navCanvas = this.root.querySelector('[data-c="nav"]')!;
    this.reticle = this.root.querySelector('svg.reticle')!;
    for (const k of ['surge', 'sway', 'heave', 'yaw'] as const) {
      const box = document.createElement('div');
      box.className = 'cmd';
      box.innerHTML = `${t('hud.cmd.' + k) === 'hud.cmd.' + k ? k.toUpperCase() : t('hud.cmd.' + k)}<div class="h"><i></i></div>`;
      this.el.cmds.appendChild(box);
      this.cmdEls[k] = { box, fill: box.querySelector('i')! };
    }
  }

  show(v: boolean): void {
    this.root.hidden = !v;
    if (!v) this.releaseTmsButtons();
  }

  /** Kept for API compatibility (the winch is driven from the keyboard / devices). */
  readonly tmsHeld = { pay: false, haul: false };
  onTmsAction: (a: PilotAction) => void = () => {};
  releaseTmsButtons(): void {
    this.tmsHeld.pay = this.tmsHeld.haul = false;
  }

  /** HUD density: full instrumentation, compact (no thrust/nav detail) or minimal (video overlay only). */
  density: 'full' | 'compact' | 'minimal' = 'full';
  cycleDensity(): 'full' | 'compact' | 'minimal' {
    this.density = this.density === 'full' ? 'compact' : this.density === 'compact' ? 'minimal' : 'full';
    this.root.dataset.density = this.density;
    return this.density;
  }

  private initBars(ids: string[]): void {
    if (this.bars.length === ids.length) return;
    this.el.bars.innerHTML = ids.map((id) => `<div class="bar"><div class="track"><div class="fill"></div></div><span>${id.replace('-', '')}</span></div>`).join('');
    this.bars = Array.from(this.el.bars.querySelectorAll<HTMLElement>('.fill'));
  }

  toast(text: string, kind: 'info' | 'ok' | 'warn' | 'alarm' = 'info', ms = 2600): void {
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild?.remove();
    setTimeout(() => d.remove(), ms);
  }

  update(d: HudData, dt: number): void {
    // Fast elements every frame.
    this.drawHeading(d);
    this.drawDepth(d);
    this.drawAttitude(d);
    this.drawNav(d);
    this.initBars(d.thrusterIds);
    d.thrusterLevels.forEach((lv, i) => {
      const f = this.bars[i];
      const h = Math.min(1, Math.abs(lv)) * 50;
      f.style.top = lv >= 0 ? `${50 - h}%` : '50%';
      f.style.height = `${h}%`;
      const load = d.thrusterLoads ? d.thrusterLoads[i] : Math.abs(lv);
      f.style.background = load > 0.95 ? COLORS.warn : COLORS.data;
    });
    for (const k of ['surge', 'sway', 'heave', 'yaw'] as const) {
      const v = Math.max(-1, Math.min(1, d.command[k]));
      const { box, fill } = this.cmdEls[k];
      fill.style.left = v >= 0 ? '50%' : `${50 + v * 50}%`;
      fill.style.width = `${Math.abs(v) * 50}%`;
      box.classList.toggle('active', Math.abs(v) > 0.02);
    }
    const showReticle = d.camera === 'operational';
    this.reticle.style.display = showReticle ? '' : 'none';
    const ring = this.el.ring as unknown as SVGCircleElement;
    const circ = 2 * Math.PI * 26;
    ring.setAttribute('stroke-dasharray', `${(d.holdProgress ?? 0) * circ} 999`);

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.08;

    const e = this.el;
    e.clock.textContent = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    e.mode.textContent = t(`hud.mode.${d.mode}`);
    e.camera.textContent = `${t('view.' + d.camera)} · ${t('hud.tilt')} ${fmt(d.tilt, 0)}°`;
    e.lights.textContent = d.lightsOn ? `${Math.round(d.lightLevel * 100)} %` : t('hud.off');
    e.lights.className = `v ${d.lightsOn ? 'ok' : 'off'}`;
    if (d.dvl) {
      const sp = Math.hypot(d.dvl.surge, d.dvl.sway);
      e.speed.textContent = `${fmt(sp, 2)} m/s · ${fmt(sp * 1.94384, 1)} kn`;
      e.speed.className = 'v';
    } else {
      e.speed.textContent = `${t('hud.noLock')} (DVL)`;
      e.speed.className = 'v off';
    }
    e.time.textContent = d.diveTime === null ? '--:--:--' : hms(d.diveTime);
    e.tether.textContent = d.crane === 'released' ? `${fmt(d.tether, 0)} m` : t('lars.' + d.larsState);
    e.pitch.textContent = `${d.pitch >= 0 ? '+' : ''}${fmt(d.pitch, 1)}°`;
    e.roll.textContent = `${d.roll >= 0 ? '+' : ''}${fmt(d.roll, 1)}°`;
    if (d.depth < 0) {
      e.alt.textContent = t('hud.surface');
      e.alt.className = 'big';
    } else if (d.altitude === null) {
      e.alt.textContent = t('hud.outOfRange');
      e.alt.className = 'big';
    } else {
      e.alt.textContent = `${fmt(d.altitude, 1)} m`;
      e.alt.className = `big ${d.altitude < 1 ? 'alarm' : d.altitude < 3 ? 'warn' : ''}`;
    }
    e.vs.textContent = `${d.verticalSpeed >= 0 ? '↑' : '↓'} ${fmt(Math.abs(d.verticalSpeed), 2)} m/s`;
    e.contact.textContent = d.contacts > 0 ? t('hud.contact') : '';
    e.contact.style.color = COLORS.warn;
    e.fine.textContent = d.fine ? t('hud.fine') : '';
    e.fine.style.color = COLORS.accent;
    e.limit.textContent = d.saturation < 0.95 ? t('hud.limit') : '';
    // TMS instrumentation (all values from the simulated winch and tether).
    const tm = d.tms;
    e.tmsMode.textContent = d.crane === 'released' ? `${t('hud.tms.mode.' + tm.mode)} · ${t('hud.tms.state.' + tm.state)}` : t('lars.' + d.larsState);
    e.tmsPayout.textContent = `${tm.payout.toFixed(1)} m`;
    e.tmsSpeed.textContent = `${tm.speed >= 0 ? '+' : ''}${tm.speed.toFixed(2)} m/s`;
    e.tmsTension.textContent = `${(tm.tension / 1000).toFixed(2)} kN`;
    e.tmsTension.className = tm.tension > tm.tensionLimit ? 'alarm' : tm.tension > tm.tensionWarn ? 'warn' : '';
    e.tmsSlack.textContent = `${t('hud.tms.slack')} ${tm.slack.toFixed(1)} m`;
    e.tmsSlack.className = tm.slack > tm.slackWarn ? 'warn' : '';
    e.tmsLen.style.width = `${(tm.payout / tm.maxLength) * 100}%`;
    const dk = d.dock;
    e.dockLine.style.display = dk ? '' : 'none';
    if (dk) {
      e.dockLine.innerHTML = `<b class="tl">TOP-HAT</b><span>${fmt(dk.distance, 1)} m</span><span>Δh ${fmt(dk.horizontal, 2)}</span><span>Δv ${fmt(dk.vertical, 2)}</span><span>Δψ ${fmt(dk.headingError, 0)}°</span><span>v ${fmt(dk.relSpeed, 2)}</span><span class="${dk.ok ? 'ok' : dk.payout > 12 ? 'warn' : ''}">${t(dk.ok ? 'dock.ready' : dk.payout > 12 ? 'dock.haul' : 'dock.align')}${dk.assist ? ' · ' + t('dock.assist') : ''}</span>`;
    }
    const warns: string[] = [];
    if (tm.tension > tm.tensionWarn) warns.push(t('hud.tms.warnTension'));
    if (tm.slack > tm.slackWarn) warns.push(t('hud.tms.warnSlack'));
    if (tm.onRov) warns.push(t('hud.tms.warnOnRov'));
    if (['limitMax', 'limitMin', 'tensionTrip', 'slip'].includes(tm.state)) warns.push(t('hud.tms.state.' + tm.state));
    e.tmsWarn.textContent = warns.join(' · ');
    // Compact instrument bar (multi-view layouts): essential data always visible.
    e.ibar.innerHTML = [
      [t('hud.depth'), `${fmt(Math.max(0, d.depth), 1)} m`],
      [t('hud.altitude'), d.altitude === null ? '---' : `${fmt(d.altitude, 1)} m`],
      [t('hud.heading'), `${pad3(d.heading)}° ${cardinal(d.heading)}`],
      [t('hud.pitch'), `${fmt(d.pitch, 1)}°`],
      [t('hud.roll'), `${fmt(d.roll, 1)}°`],
      [t('hud.speed'), d.dvl ? `${fmt(Math.hypot(d.dvl.surge, d.dvl.sway), 2)} m/s` : '---'],
      [t('hud.vspeed'), `${fmt(d.verticalSpeed, 2)} m/s`],
      [t('hud.mode'), t('hud.mode.' + d.mode)],
      ['TETHER', `${fmt(tm.payout, 0)} m · ${fmt(tm.tension / 1000, 1)} kN`, tm.tension > tm.tensionWarn || tm.slack > tm.slackWarn ? 'warn' : ''],
      ['TMS', `${tm.mode === 'auto' ? 'AUTO' : 'MAN'} · ${t('lars.' + d.larsState)}`],
    ]
      .map(([k, v, c]) => `<div${c ? ` class="${c}"` : ''}><span>${k}</span><b>${v}</b></div>`)
      .join('');
    this.lastData = d;
    // Multi-view: the mission box sits right below the instrument bar (which may wrap).
    const missionBox = this.root.querySelector<HTMLElement>('.panel.mission');
    if (missionBox) {
      const multi = this.root.dataset.layout === 'dual' || this.root.dataset.layout === 'quad';
      const top = multi ? `${e.ibar.offsetTop + e.ibar.offsetHeight + 6}px` : '';
      if (missionBox.style.top !== top) missionBox.style.top = top;
    }
    e.limit.style.color = COLORS.warn;
    if (d.tetherAtMax) {
      e.tether.textContent += ` · ${t('hud.tetherMax')}`;
      e.tether.className = 'v warn';
    } else e.tether.className = 'v';

    // Mission
    e.stageIdx.textContent = `${Math.min(d.stepIndex + 1, d.steps.length)}/${d.steps.length}`;
    if (e.stages.children.length !== d.steps.length) e.stages.innerHTML = d.steps.map(() => '<span></span>').join('');
    Array.from(e.stages.children).forEach((c, i) => {
      const st = d.steps[i]?.state;
      c.className = st === 'done' ? 'done' : st === 'active' ? 'now' : '';
      (c as HTMLElement).title = d.steps[i] ? t(d.steps[i].key) : '';
    });
    e.stage.textContent = d.stageLabel;
    e.objective.textContent = d.objective;
    if (d.checklist) {
      e.checklist.innerHTML = (['lights', 'thrusters', 'camera'] as const)
        .map((k) => `<li class="${d.checklist![k] ? 'done' : ''}">${t('mission.prep.' + k)}</li>`)
        .join('');
    } else e.checklist.innerHTML = '';
    if (d.range !== null && d.offAxis !== null && d.range < 40) {
      e.geom.innerHTML = `<span>${t('hud.dist')} <b>${fmt(d.range, 1)} m</b></span><span>Δ° <b>${fmt(d.offAxis, 0)}°</b></span>`;
    } else e.geom.innerHTML = '';
    e.progressBox.style.display = d.holdProgress === null ? 'none' : '';
    e.progress.style.width = `${(d.holdProgress ?? 0) * 100}%`;
    e.warning.textContent = d.warning ?? '';
    e.hint.textContent = d.hint ?? '';
    e.hint.style.display = d.hint ? '' : 'none';

    // Input devices
    const sm = d.spacemouse === 'on' ? `<span class="ok">SPACEMOUSE ●</span>` : d.spacemouse === 'off' ? `<span class="off">SPACEMOUSE ○</span>` : '';
    const used = new Set(Object.values(d.sources));
    const kb = used.has('keyboard') ? '<span class="ok">TECLADO</span>' : 'TECLADO';
    const gp = used.has('gamepad') ? ' · <span class="ok">GAMEPAD</span>' : '';
    e.input.innerHTML = `${kb}${gp}${sm ? ' · ' + sm : ''}`;

    // Propulsion power budget
    e.powerBox.style.display = d.powerFraction === null ? 'none' : '';
    if (d.powerFraction !== null) {
      const pf = Math.max(0, Math.min(1, d.powerFraction));
      e.power.style.width = `${pf * 100}%`;
      e.power.style.background = pf > 0.97 ? COLORS.warn : COLORS.data;
      e.powerTxt.textContent = `${Math.round(pf * 100)} %`;
    }

    // Nav info
    if (d.navTarget) {
      const dx = d.navTarget.x - d.position.x;
      const dz = d.navTarget.z - d.position.z;
      const brg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
      e.brg.textContent = `${pad3(brg)}°`;
      e.dist.textContent = `${fmt(Math.hypot(dx, dz), 0)} m`;
    } else {
      e.brg.textContent = '---';
      e.dist.textContent = '---';
    }
    e.navRange.textContent = `${this.navRange} m`;

    // OSD (video overlay)
    if (d.camera === 'operational') {
      e.osd.innerHTML = `CAM1 · ${t('hud.depth')} ${fmt(Math.max(0, d.depth), 1)} m · ${t('hud.heading')} ${pad3(d.heading)}° · ${t('hud.altitude')} ${
        d.altitude === null ? '---' : fmt(d.altitude, 1) + ' m'
      }<div class="hint">${t('hud.helpHint')}</div>`;
    } else e.osd.innerHTML = `<div class="hint">${t('hud.helpHint')}</div>`;
    e.fps.textContent = d.fps === null ? '' : `${d.fps.toFixed(0)} FPS`;
  }

  // ---------- Canvas instruments ----------
  private drawHeading(d: HudData): void {
    const c = this.headingCanvas;
    const ctx = setupCanvas(c);
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const pxPerDeg = w / 90;
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let deg = Math.floor(d.heading - 50); deg <= d.heading + 50; deg++) {
      const x = w / 2 + (deg - d.heading) * pxPerDeg;
      const dd = ((deg % 360) + 360) % 360;
      if (dd % 5 !== 0) continue;
      const major = dd % 15 === 0;
      ctx.strokeStyle = COLORS.dim;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - (major ? 12 : 6));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = labels[dd] ? COLORS.accent : COLORS.line;
        ctx.fillText(labels[dd] ?? String(dd).padStart(3, '0'), x, h - 16);
      }
    }
    if (d.headingSetpoint !== null) {
      const x = w / 2 + angleDiff(d.headingSetpoint, d.heading) * pxPerDeg;
      ctx.fillStyle = COLORS.ok;
      ctx.beginPath();
      ctx.moveTo(x - 5, h);
      ctx.lineTo(x + 5, h);
      ctx.lineTo(x, h - 7);
      ctx.fill();
    }
    // Readout box
    ctx.fillStyle = 'rgba(8,13,17,0.92)';
    ctx.strokeStyle = COLORS.line;
    ctx.fillRect(w / 2 - 30, 2, 60, 18);
    ctx.strokeRect(w / 2 - 30, 2, 60, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText(`${pad3(d.heading)}°`, w / 2, 16);
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.fillStyle = COLORS.dim;
    ctx.textAlign = 'left';
    ctx.fillText(t('hud.heading'), 6, 12);
  }

  private drawDepth(d: HudData): void {
    const c = this.depthCanvas;
    const ctx = setupCanvas(c);
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const pxPerM = h / 24;
    const depth = d.depth;
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right';
    ctx.strokeStyle = COLORS.dim;
    for (let m = Math.floor(depth - 14); m <= depth + 14; m++) {
      const y = h / 2 + (m - depth) * pxPerM;
      const major = m % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(w, y);
      ctx.lineTo(w - (major ? 14 : 7), y);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = m < 0 ? COLORS.dim : COLORS.line;
        ctx.fillText(String(m), w - 18, y + 4);
      }
    }
    if (depth < 14) {
      const y = h / 2 - depth * pxPerM;
      ctx.strokeStyle = COLORS.data;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (d.depthSetpoint !== null) {
      const y = h / 2 + (d.depthSetpoint - depth) * pxPerM;
      ctx.fillStyle = COLORS.ok;
      ctx.beginPath();
      ctx.moveTo(w, y - 5);
      ctx.lineTo(w, y + 5);
      ctx.lineTo(w - 8, y);
      ctx.fill();
    }
    // Vertical speed trend arrow.
    const vs = Math.max(-1.5, Math.min(1.5, d.verticalSpeed));
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(6, h / 2);
    ctx.lineTo(6, h / 2 - vs * pxPerM * 4);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(8,13,17,0.92)';
    ctx.strokeStyle = COLORS.line;
    ctx.fillRect(12, h / 2 - 11, w - 24, 22);
    ctx.strokeRect(12, h / 2 - 11, w - 24, 22);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText(`${fmt(depth, 1)} m`, w / 2, h / 2 + 5);
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.fillStyle = COLORS.dim;
    ctx.textAlign = 'left';
    ctx.fillText(t('hud.depth'), 6, 12);
    if (d.depthSetpoint !== null) {
      ctx.fillStyle = COLORS.ok;
      ctx.fillText(`${t('hud.hold')} ${fmt(d.depthSetpoint, 1)}`, 6, h - 6);
    }
  }

  private drawAttitude(d: HudData): void {
    const c = this.attCanvas;
    const ctx = setupCanvas(c);
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 8;
    const pxPerDeg = r / 30;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate((-d.roll * Math.PI) / 180);
    const off = d.pitch * pxPerDeg;
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(-2 * r, -2 * r + off, 4 * r, 2 * r);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(-2 * r, off, 4 * r, 2 * r);
    ctx.strokeStyle = COLORS.line;
    ctx.beginPath();
    ctx.moveTo(-2 * r, off);
    ctx.lineTo(2 * r, off);
    ctx.stroke();
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.fillStyle = COLORS.line;
    ctx.textAlign = 'left';
    for (let p = -30; p <= 30; p += 10) {
      if (p === 0) continue;
      const y = off - p * pxPerDeg;
      const half = 18;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
      ctx.fillText(String(p), half + 3, y + 3);
    }
    ctx.restore();
    // Roll scale
    ctx.strokeStyle = COLORS.dim;
    for (const a of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const ang = ((a - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      ctx.lineTo(cx + Math.cos(ang) * (r - (a % 30 === 0 ? 8 : 5)), cy + Math.sin(ang) * (r - (a % 30 === 0 ? 8 : 5)));
      ctx.stroke();
    }
    const ra = ((-d.roll - 90) * Math.PI) / 180;
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ra) * (r - 9), cy + Math.sin(ra) * (r - 9));
    ctx.lineTo(cx + Math.cos(ra + 0.06) * (r - 17), cy + Math.sin(ra + 0.06) * (r - 17));
    ctx.lineTo(cx + Math.cos(ra - 0.06) * (r - 17), cy + Math.sin(ra - 0.06) * (r - 17));
    ctx.fill();
    ctx.strokeStyle = COLORS.line;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Fixed vehicle symbol
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy);
    ctx.lineTo(cx - 10, cy);
    ctx.lineTo(cx - 5, cy + 5);
    ctx.moveTo(cx + 30, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.lineTo(cx + 5, cy + 5);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /** Draw the navigation display into another canvas (instrumentation panel). */
  drawNavTo(c: HTMLCanvasElement, d: HudData): void {
    const keep = this.navCanvas;
    this.navCanvas = c;
    this.drawNav(d);
    this.navCanvas = keep;
  }

  private drawNav(d: HudData): void {
    const c = this.navCanvas;
    const ctx = setupCanvas(c);
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    // Auto range to keep the target visible.
    let want = 40;
    if (d.navTarget) {
      const dist = Math.hypot(d.navTarget.x - d.position.x, d.navTarget.z - d.position.z);
      want = dist < 30 ? 40 : dist < 70 ? 80 : dist < 140 ? 160 : 320;
    }
    this.navRange = want;
    const scale = Math.min(w, h) / 2 / this.navRange;
    const cx = w / 2;
    const cy = h / 2;
    // north-up display
    const toS = (p: { x: number; z: number }) => [cx + (p.x - d.position.x) * scale, cy + (p.z - d.position.z) * scale] as const;
    ctx.strokeStyle = 'rgba(52,73,90,0.6)';
    ctx.lineWidth = 1;
    for (const f of [0.5, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, (Math.min(w, h) / 2) * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, 4);
    ctx.lineTo(cx, h - 4);
    ctx.moveTo(4, cy);
    ctx.lineTo(w - 4, cy);
    ctx.stroke();
    ctx.fillStyle = COLORS.dim;
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 12);

    // Pipeline & jumper
    const poly = (pts: V3[], color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = toS(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    poly(PIPELINE_PATH, 'rgba(160,170,180,0.8)', Math.max(1, 0.46 * scale));
    poly(JUMPER_PATH, 'rgba(160,170,180,0.8)', 1);
    const box = (center: V3, sx: number, sz: number, yaw: number, color: string) => {
      ctx.save();
      const [x, y] = toS(center);
      ctx.translate(x, y);
      ctx.rotate(-yaw);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.strokeRect((-sx / 2) * scale, (-sz / 2) * scale, sx * scale, sz * scale);
      ctx.restore();
    };
    box(MANIFOLD.position, MANIFOLD.size.x, MANIFOLD.size.z, MANIFOLD.yaw, COLORS.accent);
    box(TREE.position, TREE.size.x, TREE.size.z, TREE.yaw, COLORS.accent);
    box(PLET.position, PLET.size.x, PLET.size.z, 0, COLORS.accent);
    box(VESSEL.center, VESSEL.beam, VESSEL.length, 0, 'rgba(108,196,216,0.6)');

    if (d.navTarget) {
      const [tx, ty] = toS(d.navTarget);
      const inside = Math.abs(tx - cx) < w / 2 && Math.abs(ty - cy) < h / 2;
      ctx.strokeStyle = COLORS.ok;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      if (inside) {
        ctx.beginPath();
        ctx.arc(tx, ty, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tx, ty, 2, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.ok;
        ctx.fill();
      }
    }
    // ROV symbol (heading up = rotate)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((d.heading * Math.PI) / 180);
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
