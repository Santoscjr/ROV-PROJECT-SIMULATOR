import { t } from '../i18n';
import {
  BINDABLE,
  KEYBOARD_PRESETS,
  type Bindable,
  type CameraFx,
  type GraphicsQuality,
  type KeyboardPreset,
  type Settings,
  type SettingsStore,
  type StationProfileId,
  type ViewLayout,
  type ViewSource,
  type ResetCategory,
  MAX_MONITORS,
  RESET_CATEGORIES,
  STATION_PROFILES,
  VIEW_SOURCES,
  resetPatch,
  sanitizeMonitor,
} from '../config/settings';
import { buildLabel, runtimeEnvironment, shortCommit, type PublishedCheck } from '../diagnostics/buildInfo';
import type { MissionDefinition, MissionStats, OperationMission } from '../mission/types';
import type { ConditionChoice } from '../sim/conditions';
import { resolveConditions, visibilityRange } from '../sim/conditions';
import type { PilotMode } from '../control/rovController';
import type { SpaceMouseDevice } from '../input/spacemouse/spacemouseDevice';
import { SpaceMousePanel } from './spacemousePanel';

type ScreenName = 'main' | 'pause' | 'settings' | 'help' | 'report' | 'diagnostics' | null;
type SettingsTab = 'station' | 'graphics' | 'controls' | 'spacemouse' | 'environment';

export interface MenuCallbacks {
  start(missionId: MissionDefinition['id']): void;
  resume(): void;
  restart(): void;
  mainMenu(): void;
  spaceMouse(): SpaceMouseDevice | null;
  openMonitor(): boolean;
  applyProfile(id: StationProfileId): boolean;
  saveProfile(): void;
  /** Plain-text diagnostics report (version, state, errors…). */
  diagnostics(): string;
  /** Engineering view of the tether (nodes, forces); returns the new state. */
  toggleTetherDebug(): boolean;
}

/** Human-readable label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift D',
    BracketLeft: '[',
    BracketRight: ']',
    Equal: '=',
    Minus: '-',
    Escape: 'Esc',
    Enter: 'Enter',
    Space: 'Espaço',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Period: '.',
    Comma: ',',
    ControlLeft: 'Ctrl',
    AltLeft: 'Alt',
  };
  return map[code] ?? code;
}

const LOGO = `<svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
  <rect x="1" y="1" width="44" height="44" rx="3" fill="none" stroke="#34495a"/>
  <rect x="9" y="14" width="28" height="9" rx="1.5" fill="#f2a93b"/>
  <path d="M9 23h28v9H9z" fill="none" stroke="#c9d4dc" stroke-width="1.6"/>
  <circle cx="15" cy="35" r="2.4" fill="none" stroke="#6cc4d8" stroke-width="1.4"/>
  <circle cx="31" cy="35" r="2.4" fill="none" stroke="#6cc4d8" stroke-width="1.4"/>
  <path d="M23 6v8" stroke="#c9d4dc" stroke-width="1.6"/>
</svg>`;

const COND_KEYS: { key: keyof ConditionChoice; options: string[] }[] = [
  { key: 'current', options: ['off', 'low', 'normal', 'strong'] },
  { key: 'visibility', options: ['clear', 'normal', 'turbid'] },
  { key: 'light', options: ['day', 'overcast', 'night'] },
  { key: 'sea', options: ['calm', 'moderate'] },
];

export class Menus {
  readonly root: HTMLDivElement;
  private screens: Record<Exclude<ScreenName, null>, HTMLElement>;
  current: ScreenName = 'main';
  private settingsReturn: ScreenName = 'main';
  private helpReturn: ScreenName = 'main';
  private listening: { key: Bindable; btn: HTMLButtonElement } | null = null;
  private tab: SettingsTab = 'graphics';
  private smPanel: SpaceMousePanel | null = null;

  constructor(
    parent: HTMLElement,
    private readonly store: SettingsStore,
    private readonly missions: MissionDefinition[],
    private readonly cb: MenuCallbacks,
  ) {
    this.root = document.createElement('div');
    parent.appendChild(this.root);
    this.screens = {
      main: this.buildMain(),
      pause: this.buildPause(),
      settings: this.buildSettings(),
      help: this.buildHelp(),
      report: this.buildReportShell(),
      diagnostics: this.buildDiagnostics(),
    };
    Object.values(this.screens).forEach((s) => this.root.appendChild(s));
    window.addEventListener('keydown', this.onKeyCapture, true);
    store.subscribe(() => {
      this.refreshSettings();
      this.refreshMain();
    });
    this.show('main');
  }

  get open(): boolean {
    return this.current !== null;
  }

  show(name: ScreenName): void {
    if (name === 'settings' && this.current !== 'settings') this.settingsReturn = this.current;
    if (name === 'help' && this.current !== 'help') this.helpReturn = this.current;
    this.current = name;
    for (const [k, el] of Object.entries(this.screens)) el.hidden = k !== name;
    if (name === 'settings') this.refreshSettings();
    if (name === 'main') this.refreshMain();
    if (name === 'diagnostics') this.refreshDiagnostics();
    this.smPanel?.setVisible(name === 'settings' && this.tab === 'spacemouse');
    if (name) (this.screens[name].querySelector('button.primary, button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  back(): void {
    if (this.current === 'diagnostics') this.show(this.diagReturn);
    else this.show(this.current === 'help' ? this.helpReturn : this.settingsReturn);
  }

  private diagReturn: ScreenName = 'main';
  private diagTimer = 0;
  showDiagnostics(): void {
    if (this.current !== 'diagnostics') this.diagReturn = this.current;
    this.show('diagnostics');
  }

  /** Result of the published-version check (cache vs old code). */
  setBuildCheck(r: PublishedCheck): void {
    const el = this.screens.main.querySelector<HTMLElement>('[data-o="update"]');
    if (!el) return;
    if (r.state === 'newer') {
      el.hidden = false;
      el.innerHTML = `${t('build.newer', { v: r.published.version, c: shortCommit(r.published.commit) })} <button class="mini" data-a="reload">${t('build.reload')}</button>`;
      el.querySelector('[data-a="reload"]')?.addEventListener('click', () => location.reload());
    } else el.hidden = true;
  }


  /** Refresh dynamic device status (called by the app on connect/disconnect). */
  refreshDevices(): void {
    if (this.current === 'main') this.refreshMain();
    if (this.current === 'settings' && this.tab === 'spacemouse') this.smPanel?.render();
  }

  // ---------- Main menu ----------
  private buildMain(): HTMLElement {
    const s = screen();
    s.innerHTML = `
      <div class="card wide">
        <div class="menu-grid">
          <section>
            <div class="brand">${LOGO}<div><div class="eyebrow">Offshore ROV Operations</div>
              <h1>${t('app.title')}</h1><div class="sub">${t('app.subtitle')}</div></div></div>
            <h3 class="sec">${t('menu.selectOp')}</h3>
            <div class="op-list" data-o="ops"></div>
            <h3 class="sec">${t('menu.conditions')}</h3>
            <div class="cond-grid" data-o="conds"></div>
            <p class="muted small" data-o="condNote"></p>
          </section>
          <section class="side">
            <div class="menu-actions">
              <button class="primary big" data-a="start">${t('menu.start')}</button>
              <button data-a="controls">${t('menu.controls')}</button>
              <button data-a="settings">${t('menu.settings')}</button>
            </div>
            <h3 class="sec">${t('menu.station')}</h3>
            <div class="quick">
              <label><span>${t('settings.profile')}</span><select data-q="profile">${STATION_PROFILES.map((p) => `<option value="${p}">${t('profile.' + p)}</option>`).join('')}</select></label>
              <label><span>${t('settings.graphics')}</span><select data-q="graphics">${(['low', 'medium', 'high'] as GraphicsQuality[]).map((q) => `<option value="${q}">${t('settings.graphics.' + q)}</option>`).join('')}</select></label>
            </div>
            <p class="muted small" data-o="stationDesc"></p>
            <div class="menu-actions row">
              <button data-a="openMonitor">${t('menu.openMonitor')}</button>
              <button data-a="diag">${t('menu.diagnostics')}</button>
            </div>
            <h3 class="sec">${t('menu.devices')}</h3>
            <div class="devices" data-o="devices"></div>
            <dl class="facts compact">
              <dt>${t('menu.vehicle')}</dt><dd>${t('menu.vehicleDesc')}</dd>
              <dt>${t('menu.site')}</dt><dd>${t('menu.siteDesc')}</dd>
            </dl>
            <p class="disclaimer">${t('menu.disclaimer')}</p>
            <p class="muted small version" data-o="build" title="${t('build.tooltip')}">${buildLabel()}</p>
            <div class="update-banner" data-o="update" hidden></div>
          </section>
        </div>
      </div>`;
    on(s, 'start', () => this.cb.start(this.store.get().mission));
    on(s, 'controls', () => this.show('help'));
    on(s, 'settings', () => this.show('settings'));
    on(s, 'openMonitor', () => {
      if (!this.cb.openMonitor()) alert(t('settings.monitorBlocked'));
    });
    on(s, 'diag', () => this.showDiagnostics());
    const prof = s.querySelector<HTMLSelectElement>('[data-q="profile"]')!;
    prof.addEventListener('change', () => {
      if (!this.cb.applyProfile(prof.value as StationProfileId)) alert(t('profile.customEmpty'));
      this.refreshMain();
    });
    const gfx = s.querySelector<HTMLSelectElement>('[data-q="graphics"]')!;
    gfx.addEventListener('change', () => this.store.update({ graphics: gfx.value as GraphicsQuality }));
    return s;
  }

  private refreshMain(): void {
    const s = this.screens?.main;
    if (!s) return;
    const st = this.store.get();
    const qp = s.querySelector<HTMLSelectElement>('[data-q="profile"]');
    if (qp && document.activeElement !== qp) qp.value = st.stationProfile;
    const qg = s.querySelector<HTMLSelectElement>('[data-q="graphics"]');
    if (qg && document.activeElement !== qg) qg.value = st.graphics;
    const sd = s.querySelector('[data-o="stationDesc"]');
    if (sd) sd.textContent = t('profile.desc.' + st.stationProfile) + ' ' + t('menu.monitorCount', { n: st.monitors.length });
    const ops = s.querySelector('[data-o="ops"]')!;
    ops.innerHTML = this.missions
      .map(
        (m) => `<button class="op ${m.id === st.mission ? 'sel' : ''}" data-op="${m.id}" aria-pressed="${m.id === st.mission}">
          <span class="op-head"><strong>${t(m.titleKey)}</strong><span class="pips" title="${t('menu.difficulty')}">${[1, 2, 3]
            .map((i) => `<i class="${i <= m.difficulty ? 'on' : ''}"></i>`)
            .join('')}</span></span>
          <span class="op-desc">${t(m.descKey)}</span></button>`,
      )
      .join('');
    ops.querySelectorAll<HTMLButtonElement>('[data-op]').forEach((b) =>
      b.addEventListener('click', () => this.store.update({ mission: b.dataset.op as Settings['mission'] })),
    );
    const def = this.missions.find((m) => m.id === st.mission)!;
    const forced = def.forcedConditions ?? {};
    const conds = s.querySelector('[data-o="conds"]')!;
    conds.innerHTML = COND_KEYS.map(({ key, options }) => {
      const locked = forced[key] !== undefined;
      const val = (forced[key] ?? st[key]) as string;
      return `<label class="cond ${locked ? 'locked' : ''}"><span>${t('settings.' + key)}</span>
        <select data-cond="${key}" ${locked ? 'disabled' : ''}>${options
          .map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${t(`settings.${key}.${o}`)}</option>`)
          .join('')}</select></label>`;
    }).join('');
    conds.querySelectorAll<HTMLSelectElement>('select[data-cond]').forEach((sel) =>
      sel.addEventListener('change', () => this.store.update({ [sel.dataset.cond!]: sel.value } as Partial<Settings>)),
    );
    const eff = resolveConditions({ current: st.current, visibility: st.visibility, light: st.light, sea: st.sea }, forced);
    s.querySelector('[data-o="condNote"]')!.textContent =
      (Object.keys(forced).length ? t('menu.condForced') + ' ' : '') + t('menu.visibilityApprox', { m: visibilityRange(eff).toFixed(0) });

    // Devices
    const sm = this.cb.spaceMouse();
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads()).filter((p) => p && p.connected) : [];
    const smState = !sm ? 'unsupported' : sm.connected() ? 'on' : 'off';
    s.querySelector('[data-o="devices"]')!.innerHTML = `
      <div class="dev on"><span class="dot"></span>${t('dev.keyboard')}</div>
      <div class="dev ${pads.length ? 'on' : 'off'}"><span class="dot"></span>${t('dev.gamepad')} <span class="muted small">${pads.length ? '' : t('dev.notDetected')}</span></div>
      <div class="dev ${smState}"><span class="dot"></span>${t('dev.spacemouse')}
        <span class="muted small">${smState === 'on' ? sm!.label : smState === 'off' ? t('sm.notConnected') : t('dev.unsupported')}</span>
        ${smState === 'off' ? `<button class="mini" data-a="smconnect">${t('settings.spacemouseConnect')}</button>` : ''}</div>`;
    s.querySelector('[data-a="smconnect"]')?.addEventListener('click', () => void sm?.requestAndOpen().then(() => this.refreshMain()));
  }

  private buildPause(): HTMLElement {
    const s = screen(true);
    s.innerHTML = `
      <div class="card" style="max-width:420px">
        <header><h2>${t('menu.paused')}</h2><span class="eyebrow">Esc</span></header>
        <div class="body menu-actions">
          <button class="primary" data-a="resume">${t('menu.resume')}</button>
          <button data-a="controls">${t('menu.controls')}</button>
          <button data-a="settings">${t('menu.settings')}</button>
          <button data-a="restart">${t('menu.restart')}</button>
          <button data-a="main">${t('menu.mainMenu')}</button>
        </div>
      </div>`;
    on(s, 'resume', () => this.cb.resume());
    on(s, 'controls', () => this.show('help'));
    on(s, 'settings', () => this.show('settings'));
    on(s, 'restart', () => this.cb.restart());
    on(s, 'main', () => this.cb.mainMenu());
    return s;
  }

  // ---------- Help ----------
  private buildHelp(): HTMLElement {
    const s = screen(true);
    const card = document.createElement('div');
    card.className = 'card';
    s.appendChild(card);
    const render = () => {
      const b = this.store.get().bindings;
      const row = (k: Bindable) => `<span>${b[k].map((c) => `<kbd>${keyLabel(c)}</kbd>`).join(' ')}</span><span>${t('bind.' + k)}</span>`;
      card.innerHTML = `
        <header><h2>${t('help.title')}</h2><button data-a="back">${t('help.close')}</button></header>
        <div class="body help-grid">
          <div>
            <h3>${t('settings.bindings')}</h3>
            <div class="keys">${BINDABLE.map(row).join('')}</div>
          </div>
          <div>
            <h3>${t('help.first')}</h3>
            <ol class="help-steps">${[1, 2, 3, 4, 5].map((i) => `<li>${t('help.first.' + i)}</li>`).join('')}</ol>
            <h3 style="margin-top:18px">${t('help.modes')}</h3>
            <p class="help-text">${t('help.modeManual')}</p>
            <p class="help-text">${t('help.modeStabilize')}</p>
            <p class="help-text">${t('help.modeDepthHold')}</p>
            <h3 style="margin-top:18px">${t('help.mouse')}</h3>
            <p class="help-text">${t('help.mouseOp')}</p>
            <p class="help-text">${t('help.mouseExt')}</p>
            <h3 style="margin-top:18px">${t('help.spacemouse')}</h3>
            <p class="help-text">${t('help.spacemouseDesc')}</p>
            <h3 style="margin-top:18px">${t('help.gamepad')}</h3>
            <p class="help-text">${t('help.gamepadDesc')}</p>
            <h3 style="margin-top:18px">${t('help.combine')}</h3>
            <p class="help-text">${t('help.combineDesc')}</p>
          </div>
        </div>`;
      on(card, 'back', () => this.back());
    };
    render();
    this.store.subscribe(render);
    return s;
  }

  // ---------- Settings ----------
  private buildSettings(): HTMLElement {
    const s = screen(true);
    const tabs: SettingsTab[] = ['station', 'graphics', 'controls', 'spacemouse', 'environment'];
    s.innerHTML = `
      <div class="card">
        <header><h2>${t('settings.title')}</h2><button data-a="back">${t('menu.back')}</button></header>
        <nav class="tabs" role="tablist">${tabs
          .map((tb) => `<button role="tab" data-tab="${tb}">${t('settings.tab.' + tb)}</button>`)
          .join('')}</nav>
        <div class="body">
          <div class="tab-pane settings-grid" data-pane="station">
            <div>
              <h3>${t('settings.profile')}</h3>
              <div class="field"><label for="s-prof">${t('settings.profile')}</label><select id="s-prof" data-o="profileSel">${STATION_PROFILES.map((p) => `<option value="${p}">${t('profile.' + p)}</option>`).join('')}</select></div>
              <div class="field"><span></span><span class="ctl"><button data-a="applyProfile">${t('settings.profileApply')}</button><button data-a="saveProfile">${t('settings.profileSave')}</button></span></div>
              <p class="muted small" data-o="profileDesc"></p>
              <h3 style="margin-top:18px">${t('settings.mainWindow')}</h3>
              <div class="field"><label for="s-layout">${t('settings.layout.views')}</label>
                <select id="s-layout" data-s="layout">${['single', 'dual', 'quad'].map((l) => `<option value="${l}">${t('msg.layout.' + l)}</option>`).join('')}</select></div>
              <p class="muted small">${t('settings.stationNote')}</p>
              <h3 style="margin-top:18px">${t('settings.hudItems')}</h3>
              ${(['compass', 'depth', 'attitude', 'tether', 'camera', 'alarms'] as const)
                .map((k) => `<div class="field"><label for="n-hud-${k}">${t('settings.hudItems.' + k)}</label><input id="n-hud-${k}" type="checkbox" data-n="hudItems.${k}"></div>`)
                .join('')}
              <p class="muted small">${t('settings.hudItemsNote')}</p>
              <div class="field"><label for="s-guide">${t('settings.guide')}</label><select id="s-guide" data-s="guide">${(['expanded', 'compact', 'hidden'] as const)
                .map((g) => `<option value="${g}">${t('settings.guide.' + g)}</option>`)
                .join('')}</select></div>
            </div>
            <div>
              <h3>${t('settings.monitors')}</h3>
              <div class="monitors" data-o="monitors"></div>
              <div class="field"><span></span><span class="ctl"><button data-a="addMonitor">${t('settings.monitorAdd')}</button><button data-a="monitor">${t('settings.monitorOpen')}</button></span></div>
              <p class="muted small">${t('settings.monitorNote')}</p>
              <p class="muted small">${t('settings.windowApiNote')}</p>
            </div>
          </div>
          <div class="tab-pane settings-grid" data-pane="graphics">
            <div>
              <h3>${t('settings.graphics')}</h3>
              <div class="field"><label for="s-gfx">${t('settings.graphics')}</label>
                <select id="s-gfx" data-s="graphics">
                  ${(['low', 'medium', 'high'] as GraphicsQuality[]).map((q) => `<option value="${q}">${t('settings.graphics.' + q)}</option>`).join('')}
                </select></div>
              <p class="muted small">${t('settings.graphicsNote')}</p>
              <div class="field"><label for="s-fps">${t('settings.fps')}</label><input id="s-fps" type="checkbox" data-s="showFps"></div>
              <div class="field"><label for="s-vol">${t('settings.volume')}</label><span class="ctl"><input id="s-vol" type="range" min="0" max="1" step="0.05" data-s="volume"><output data-o="volume"></output></span></div>
              <div class="field"><label for="s-hints">${t('settings.hints')}</label><input id="s-hints" type="checkbox" data-s="showHints"></div>
              <h3 style="margin-top:18px">${t('settings.sonar')}</h3>
              ${nSelect('sonar.range', ['10', '20', '40', '60'], '', ' m')}
              ${nRange('sonar.gain', 0.3, 3, 0.05)}
              ${nSelect('sonar.quality', ['low', 'medium', 'high'], 'settings.graphics.')}
              ${nRange('sonar.tilt', 0, 45, 1)}
            </div>
            <div>
              <h3>${t('settings.camera')}</h3>
              ${fxRange('distortion', 0, 1, 0.05)}
              ${fxRange('noise', 0, 1, 0.05)}
              ${fxRange('vignette', 0, 1, 0.05)}
              ${fxRange('contrast', 0.8, 1.3, 0.01)}
              ${fxRange('exposureBias', -1.5, 1.5, 0.1)}
              <div class="field"><label for="fx-ae">${t('settings.fx.autoExposure')}</label><input id="fx-ae" type="checkbox" data-fx="autoExposure"></div>
              <p class="muted small">${t('settings.fxNote')}</p>
              <h3 style="margin-top:18px">${t('settings.water')}</h3>
              <div class="field"><label for="s-part">${t('settings.particles')}</label><span class="ctl"><input id="s-part" type="range" min="0" max="2" step="0.1" data-s="particles"><output data-o="particles"></output></span></div>
              <div class="field"><label for="s-sed">${t('settings.sediment')}</label><span class="ctl"><input id="s-sed" type="range" min="0" max="2" step="0.1" data-s="sediment"><output data-o="sediment"></output></span></div>
              <p class="muted small">${t('settings.waterNote')}</p>
              <h3 style="margin-top:18px">${t('settings.lighting')}</h3>
              ${nRange('lighting.front', 0.25, 2, 0.05)}
              ${nRange('lighting.top', 0, 3, 0.05)}
              ${nRange('lighting.tms', 0.25, 3, 0.05)}
              ${nSelect('lighting.observer', ['normal', 'assisted'], 'settings.lighting.observer.')}
              <div class="field"><label for="n-lighting-tetherAssist">${t('settings.lighting.tetherAssist')}</label><input id="n-lighting-tetherAssist" type="checkbox" data-n="lighting.tetherAssist"></div>
              <p class="muted small">${t('settings.lightingNote')}</p>
            </div>
          </div>
          <div class="tab-pane settings-grid" data-pane="controls">
            <div>
              <h3>${t('menu.controls')}</h3>
              <div class="field"><label for="s-sens">${t('settings.sensitivity')}</label><span class="ctl"><input id="s-sens" type="range" min="0.2" max="1" step="0.05" data-s="sensitivity"><output data-o="sensitivity"></output></span></div>
              <div class="field"><label for="s-ramp">${t('settings.keyRamp')}</label><span class="ctl"><input id="s-ramp" type="range" min="0" max="1" step="0.05" data-s="keyRamp"><output data-o="keyRamp"></output></span></div>
              <div class="field"><label for="s-mouse">${t('settings.mouse')}</label><span class="ctl"><input id="s-mouse" type="range" min="0.2" max="3" step="0.1" data-s="mouseSensitivity"><output data-o="mouseSensitivity"></output></span></div>
              <div class="field"><label for="s-dz">${t('settings.deadzone')}</label><span class="ctl"><input id="s-dz" type="range" min="0" max="0.4" step="0.01" data-s="gamepadDeadzone"><output data-o="gamepadDeadzone"></output></span></div>
              <div class="field" style="display:block"><div style="margin-bottom:6px">${t('settings.invert')}</div>
                <div class="inv-row">${(['surge', 'sway', 'heave', 'yaw', 'camTilt'] as const)
                  .map((a) => `<label><input type="checkbox" data-inv="${a}"> ${t('axis.' + a)}</label>`)
                  .join('')}</div></div>
              <div class="field"><label for="s-mode">${t('settings.mode')}</label>
                <select id="s-mode" data-s="defaultMode">${(['manual', 'stabilize', 'depthHold'] as PilotMode[])
                  .map((m) => `<option value="${m}">${t('hud.mode.' + m)}</option>`)
                  .join('')}</select></div>
            </div>
            <div>
              <div class="field"><label for="s-lay">${t('settings.layout')}</label>
                <select id="s-lay" data-s="keyboardPreset">${(['wasd', 'arrows'] as KeyboardPreset[])
                  .map((p) => `<option value="${p}">${t('settings.layout.' + p)}</option>`)
                  .join('')}</select></div>
              <h3 style="margin-top:12px">${t('settings.bindings')}</h3>
              <table class="bind-table"><tbody data-o="binds"></tbody></table>
            </div>
          </div>
          <div class="tab-pane" data-pane="spacemouse"></div>
          <div class="tab-pane settings-grid" data-pane="environment">
            <div>
              <h3>${t('menu.conditions')}</h3>
              ${COND_KEYS.map(
                ({ key, options }) => `<div class="field"><label>${t('settings.' + key)}</label>
                <select data-s="${key}">${options.map((o) => `<option value="${o}">${t(`settings.${key}.${o}`)}</option>`).join('')}</select></div>`,
              ).join('')}
              <p class="muted small">${t('settings.condNote')}</p>
              <h3 style="margin-top:18px">${t('settings.tophat')}</h3>
              <div class="field"><label for="s-tdm">${t('settings.tmsDepthMode')}</label><select id="s-tdm" data-s="tmsDepthMode"><option value="fixed">${t('settings.tmsDepthMode.fixed')}</option><option value="seabed">${t('settings.tmsDepthMode.seabed')}</option></select></div>
              <div class="field"><label for="s-tdep">${t('settings.tmsDepth')}</label><span class="ctl"><input id="s-tdep" type="range" min="20" max="100" step="5" data-s="tmsDepth"><output data-o="tmsDepth"></output></span></div>
              <div class="field"><label for="s-tas">${t('settings.tmsAboveSeabed')}</label><span class="ctl"><input id="s-tas" type="range" min="10" max="60" step="5" data-s="tmsAboveSeabed"><output data-o="tmsAboveSeabed"></output></span></div>
              <p class="muted small">${t('settings.tmsDepthNote')}</p>
              <div class="field"><label for="s-seed">${t('settings.environmentSeed')}</label><span class="ctl"><input id="s-seed" type="range" min="0" max="99" step="1" data-s="environmentSeed"><output data-o="environmentSeed"></output></span></div>
              <p class="muted small">${t('settings.environmentSeedNote')}</p>
              <div class="field"><label for="s-dock">${t('settings.dockAssist')}</label><input id="s-dock" type="checkbox" data-s="dockAssist"></div>
              <p class="muted small">${t('settings.tophatNote')}</p>
              <h3 style="margin-top:18px">${t('settings.tether')}</h3>
              <div class="field"><label for="s-tb">${t('settings.tetherBuoyancy')}</label>
                <select id="s-tb" data-s="tetherBuoyancy">${['positive', 'neutral', 'negative'].map((b) => `<option value="${b}">${t('settings.tetherBuoyancy.' + b)}</option>`).join('')}</select></div>
            </div>
            <div>
              <h3>${t('settings.condWhat')}</h3>
              <p class="help-text">${t('settings.condWhat.current')}</p>
              <p class="help-text">${t('settings.condWhat.visibility')}</p>
              <p class="help-text">${t('settings.condWhat.light')}</p>
              <p class="help-text">${t('settings.condWhat.sea')}</p>
            </div>
          </div>
        </div>
        <footer><span class="ctl"><select data-o="resetCat">${Object.keys(RESET_CATEGORIES)
          .map((c) => `<option value="${c}">${t('reset.' + c)}</option>`)
          .join('')}<option value="all">${t('reset.all')}</option></select><button data-a="reset">${t('settings.resetDefaults')}</button></span><button class="primary" data-a="back">${t('menu.back')}</button></footer>
      </div>`;
    s.querySelectorAll<HTMLElement>('[data-a="back"]').forEach((b) => b.addEventListener('click', () => this.back()));
    on(s, 'reset', () => {
      const cat = (s.querySelector('[data-o="resetCat"]') as HTMLSelectElement).value as ResetCategory | 'all';
      const scope = cat === 'all' ? t('reset.all') : `${t('reset.' + cat)} (${RESET_CATEGORIES[cat].join(', ')})`;
      if (!confirm(t('reset.confirm', { scope }))) return;
      if (cat === 'all') this.store.reset();
      else this.store.update(resetPatch(cat));
    });
    on(s, 'applyProfile', () => {
      const id = (s.querySelector('[data-o="profileSel"]') as HTMLSelectElement).value as StationProfileId;
      if (!this.cb.applyProfile(id)) alert(t('profile.customEmpty'));
    });
    on(s, 'saveProfile', () => this.cb.saveProfile());
    on(s, 'addMonitor', () => {
      const ms = this.store.get().monitors;
      if (ms.length >= MAX_MONITORS) return;
      this.store.update({ monitors: [...ms, sanitizeMonitor({ layout: 'single', sources: ['instruments'] })], stationProfile: 'custom' });
    });
    on(s, 'monitor', () => {
      if (!this.cb.openMonitor()) alert(t('settings.monitorBlocked'));
    });
    s.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab as SettingsTab)));
    this.smPanel = new SpaceMousePanel(this.cb.spaceMouse());
    s.querySelector('[data-pane="spacemouse"]')!.appendChild(this.smPanel.el);

    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.s as keyof Settings;
        let value: unknown;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') value = input.checked;
        else if (input instanceof HTMLInputElement && input.type === 'range') value = Number(input.value);
        else value = input.value;
        if (key === 'keyboardPreset') {
          this.store.update({ keyboardPreset: value as KeyboardPreset, bindings: structuredClone(KEYBOARD_PRESETS[value as KeyboardPreset]) });
        } else this.store.update({ [key]: value } as Partial<Settings>);
      });
    });
    // Nested settings (group.key): lighting, sonar, HUD items.
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-n]').forEach((input) =>
      input.addEventListener('input', () => {
        const [g, k] = input.dataset.n!.split('.') as [NestedGroup, string];
        const cur = this.store.get()[g] as unknown as Record<string, unknown>;
        let val: unknown = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value;
        if (typeof cur[k] === 'number') val = Number(val);
        this.store.update({ [g]: { ...cur, [k]: val } } as Partial<Settings>);
        if (input instanceof HTMLSelectElement) input.blur();
      }),
    );
    s.querySelectorAll<HTMLInputElement>('[data-fx]').forEach((input) =>
      input.addEventListener('input', () => {
        const k = input.dataset.fx as keyof CameraFx;
        const val = input.type === 'checkbox' ? input.checked : Number(input.value);
        this.store.update({ cameraFx: { ...this.store.get().cameraFx, [k]: val } });
      }),
    );
    s.querySelectorAll<HTMLInputElement>('[data-inv]').forEach((cb) =>
      cb.addEventListener('change', () => {
        const inv = { ...this.store.get().invert, [cb.dataset.inv!]: cb.checked };
        this.store.update({ invert: inv });
      }),
    );
    return s;
  }

  /** Editor of the additional monitor windows (layout, strip, sources, locks). */
  private renderMonitors(host: Element | null): void {
    if (!host) return;
    if (host.contains(document.activeElement) && document.activeElement !== document.body) return;
    const ms = this.store.get().monitors;
    const nPanels = (l: ViewLayout) => (l === 'quad' ? 4 : l === 'dual' ? 2 : 1);
    host.innerHTML = ms.length
      ? ms
          .map(
            (m, k) => `<fieldset class="mon" data-k="${k}"><legend>MONITOR ${k + 2}</legend>
          <label>${t('settings.monitorPanels')} <select data-m="layout">${(['single', 'dual', 'quad'] as ViewLayout[])
            .map((l) => `<option value="${l}" ${l === m.layout ? 'selected' : ''}>${t('monitor.layout.' + l)}</option>`)
            .join('')}</select></label>
          <label>${t('settings.monitorStrip')} <select data-m="instruments">${(['full', 'compact', 'hidden'] as const)
            .map((l) => `<option value="${l}" ${l === m.instruments ? 'selected' : ''}>${t('monitor.instr.' + l)}</option>`)
            .join('')}</select></label>
          <div class="mon-src">${m.sources
            .slice(0, nPanels(m.layout))
            .map(
              (src, i) =>
                `<label>${i + 1} <select data-src="${i}">${VIEW_SOURCES.map((v) => `<option value="${v}" ${v === src ? 'selected' : ''}>${t('view.' + v)}</option>`).join('')}</select></label>`,
            )
            .join('')}</div>
          <button class="mini" data-m="remove">${t('settings.monitorRemove')}</button></fieldset>`,
          )
          .join('')
      : `<p class="muted small">${t('settings.monitorNone')}</p>`;
    host.querySelectorAll<HTMLFieldSetElement>('fieldset.mon').forEach((fs) => {
      const k = Number(fs.dataset.k);
      const upd = (f: (m: Settings['monitors'][number]) => void) => {
        const monitors = structuredClone(this.store.get().monitors);
        f(monitors[k]);
        this.store.update({ monitors, stationProfile: 'custom' });
      };
      fs.querySelector<HTMLSelectElement>('[data-m="layout"]')!.addEventListener('change', (e) => {
        upd((m) => (m.layout = (e.target as HTMLSelectElement).value as ViewLayout));
        (e.target as HTMLElement).blur();
      });
      fs.querySelector<HTMLSelectElement>('[data-m="instruments"]')!.addEventListener('change', (e) => {
        upd((m) => (m.instruments = (e.target as HTMLSelectElement).value as Settings['monitors'][number]['instruments']));
        (e.target as HTMLElement).blur();
      });
      fs.querySelectorAll<HTMLSelectElement>('[data-src]').forEach((sel) =>
        sel.addEventListener('change', () => {
          upd((m) => (m.sources[Number(sel.dataset.src)] = sel.value as ViewSource));
          sel.blur();
        }),
      );
      fs.querySelector('[data-m="remove"]')!.addEventListener('click', () => {
        const monitors = this.store.get().monitors.filter((_, i) => i !== k);
        this.store.update({ monitors, stationProfile: 'custom' });
      });
    });
  }

  // ---------- Diagnostics ----------
  private buildDiagnostics(): HTMLElement {
    const s = screen(true);
    s.innerHTML = `
      <div class="card">
        <header><h2>${t('diag.title')}</h2><span class="eyebrow">${runtimeEnvironment()}</span></header>
        <div class="body"><pre class="diag" data-o="diag"></pre></div>
        <footer><span class="ctl"><button data-a="copy">${t('diag.copy')}</button><button data-a="tether">${t('diag.tether')}</button></span><button class="primary" data-a="back">${t('menu.back')}</button></footer>
      </div>`;
    s.querySelector('[data-a="back"]')!.addEventListener('click', () => this.back());
    on(s, 'copy', () => void navigator.clipboard?.writeText(this.cb.diagnostics()).catch(() => undefined));
    on(s, 'tether', () => {
      const onState = this.cb.toggleTetherDebug();
      (s.querySelector('[data-a="tether"]') as HTMLButtonElement).textContent = t(onState ? 'diag.tetherOff' : 'diag.tether');
    });
    return s;
  }

  private refreshDiagnostics(): void {
    clearTimeout(this.diagTimer);
    if (this.current !== 'diagnostics') return;
    const pre = this.screens.diagnostics.querySelector('[data-o="diag"]');
    if (pre) pre.textContent = this.cb.diagnostics();
    this.diagTimer = window.setTimeout(() => this.refreshDiagnostics(), 1000);
  }

  setTab(tab: SettingsTab): void {
    this.tab = tab;
    const s = this.screens.settings;
    s.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    s.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (tab === 'spacemouse') this.smPanel?.render();
    this.smPanel?.setVisible(this.current === 'settings' && tab === 'spacemouse');
  }

  private refreshSettings(): void {
    const s = this.screens?.settings;
    if (!s) return;
    this.setTab(this.tab);
    const v = this.store.get();
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((input) => {
      const val = v[input.dataset.s as keyof Settings];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!val;
      else if (document.activeElement !== input) input.value = String(val);
    });
    s.querySelectorAll<HTMLInputElement>('[data-fx]').forEach((input) => {
      const val = v.cameraFx[input.dataset.fx as keyof CameraFx];
      if (input.type === 'checkbox') input.checked = !!val;
      else {
        if (document.activeElement !== input) input.value = String(val);
        const out = input.nextElementSibling as HTMLOutputElement | null;
        if (out) out.textContent = (val as number).toFixed(2);
      }
    });
    // Station tab.
    const ps = s.querySelector<HTMLSelectElement>('[data-o="profileSel"]');
    if (ps && document.activeElement !== ps) ps.value = v.stationProfile;
    const pd = s.querySelector('[data-o="profileDesc"]');
    if (pd) pd.textContent = t('profile.desc.' + (ps?.value ?? v.stationProfile));
    this.renderMonitors(s.querySelector('[data-o="monitors"]'));
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-n]').forEach((input) => {
      const [g, k] = input.dataset.n!.split('.') as [NestedGroup, string];
      const val = (v[g] as unknown as Record<string, unknown>)[k];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!val;
      else {
        if (document.activeElement !== input) input.value = String(val);
        const out = input.nextElementSibling as HTMLOutputElement | null;
        if (out && typeof val === 'number') out.textContent = val.toFixed(2);
      }
    });
    s.querySelectorAll<HTMLOutputElement>('output[data-o]').forEach((o) => {
      const val = v[o.dataset.o as keyof Settings];
      if (typeof val === 'number') o.textContent = val.toFixed(2);
    });
    s.querySelectorAll<HTMLInputElement>('[data-inv]').forEach((cb) => {
      cb.checked = v.invert[cb.dataset.inv as keyof Settings['invert']];
    });
    const tbody = s.querySelector('[data-o="binds"]')!;
    tbody.innerHTML = BINDABLE.map(
      (k) => `<tr><td>${t('bind.' + k)}</td><td><button data-bind="${k}">${v.bindings[k].map(keyLabel).join(' / ') || '—'}</button></td></tr>`,
    ).join('');
    tbody.querySelectorAll<HTMLButtonElement>('[data-bind]').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (this.listening) this.listening.btn.classList.remove('listening');
        this.listening = { key: btn.dataset.bind as Bindable, btn };
        btn.classList.add('listening');
        btn.textContent = t('settings.pressKey');
      }),
    );
  }

  /** Captures the next key for rebinding (before the game sees it). */
  private onKeyCapture = (e: KeyboardEvent) => {
    if (!this.listening) {
      if (e.code === 'Escape' && (this.current === 'settings' || this.current === 'help')) {
        e.stopPropagation();
        e.preventDefault();
        this.back();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const { key } = this.listening;
    this.listening = null;
    if (e.code === 'Escape') {
      this.refreshSettings();
      return;
    }
    const bindings = structuredClone(this.store.get().bindings);
    // A key can only drive one control: remove it elsewhere.
    for (const k of BINDABLE) bindings[k] = bindings[k].filter((c) => c !== e.code);
    bindings[key] = [e.code];
    this.store.update({ bindings });
  };

  // ---------- Report ----------
  private buildReportShell(): HTMLElement {
    const s = screen();
    s.innerHTML = `<div class="card" style="max-width:680px"></div>`;
    return s;
  }

  showReport(def: MissionDefinition, mission: OperationMission, conditionsLabel: string): void {
    const stats: MissionStats = mission.stats;
    const card = this.screens.report.querySelector('.card')!;
    const time = (stats.endTime ?? mission.time) - (stats.startTime ?? 0);
    const mm = Math.floor(time / 60);
    const ss = Math.floor(time % 60);
    const hardest = stats.collisions.reduce((m, c) => Math.max(m, c.speed), 0);
    const condition = mission.condition();
    const cond = { ok: ['report.state.ok', 'status-ok'], minor: ['report.state.minor', 'status-warn'], damage: ['report.state.damage', 'status-alarm'] }[condition];
    const lines = mission
      .reportLines()
      .map((l) => `<tr><th>${t(l.labelKey)}</th><td class="${l.status ? 'status-' + (l.status === 'alarm' ? 'alarm' : l.status) : ''}">${l.value}</td></tr>`)
      .join('');
    const deviations = stats.deviations.length
      ? stats.deviations.map((d) => t(d.key, d.params)).join('<br>')
      : `<span class="status-ok">${t('report.noDeviations')}</span>`;
    card.innerHTML = `
      <header><h2>${t('report.title')}</h2><span class="eyebrow">${t(def.titleKey)}</span></header>
      <div class="body">
        <table class="report-table">
          <tr><th>${t('report.objective')}</th><td class="${mission.complete ? 'status-ok' : 'status-warn'}">${t(mission.complete ? 'report.objective.done' : 'report.objective.incomplete')}</td></tr>
          <tr><th>${t('report.time')}</th><td>${mm} min ${String(ss).padStart(2, '0')} s</td></tr>
          <tr><th>${t('report.maxDepth')}</th><td>${stats.maxDepth.toFixed(1)} m</td></tr>
          <tr><th>${t('report.distance')}</th><td>${stats.distance.toFixed(0)} m</td></tr>
          ${lines}
          <tr><th>${t('report.collisions')}</th><td>${stats.collisions.length}${hardest > 0 ? ` · ${t('report.hardest')} ${hardest.toFixed(2)} m/s` : ''}</td></tr>
          <tr><th>${t('report.deviations')}</th><td>${deviations}</td></tr>
          <tr><th>${t('report.conditions')}</th><td>${conditionsLabel}</td></tr>
          <tr><th>${t('report.state')}</th><td class="${cond[1]}">${t(cond[0])}</td></tr>
        </table>
      </div>
      <footer><button data-a="main">${t('menu.mainMenu')}</button><button class="primary" data-a="new">${t('report.new')}</button></footer>`;
    on(card as HTMLElement, 'main', () => this.cb.mainMenu());
    on(card as HTMLElement, 'new', () => this.cb.restart());
    this.show('report');
    (card.querySelector('button.primary') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }
}

type NestedGroup = 'lighting' | 'sonar' | 'hudItems';

function nRange(path: string, min: number, max: number, step: number): string {
  const id = 'n-' + path.replace('.', '-');
  return `<div class="field"><label for="${id}">${t('settings.' + path)}</label><span class="ctl"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" data-n="${path}"><output></output></span></div>`;
}

function nSelect(path: string, values: string[], labelPrefix: string, suffix = ''): string {
  const id = 'n-' + path.replace('.', '-');
  return `<div class="field"><label for="${id}">${t('settings.' + path)}</label><select id="${id}" data-n="${path}">${values
    .map((v) => `<option value="${v}">${labelPrefix ? t(labelPrefix + v) : v}${suffix}</option>`)
    .join('')}</select></div>`;
}

function fxRange(key: keyof CameraFx, min: number, max: number, step: number): string {
  return `<div class="field"><label for="fx-${key}">${t('settings.fx.' + key)}</label><span class="ctl"><input id="fx-${key}" type="range" min="${min}" max="${max}" step="${step}" data-fx="${key}"><output></output></span></div>`;
}

function screen(translucent = false): HTMLElement {
  const s = document.createElement('div');
  s.className = `screen${translucent ? ' translucent' : ''}`;
  s.hidden = true;
  return s;
}

function on(root: HTMLElement, action: string, fn: () => void): void {
  root.querySelector<HTMLElement>(`[data-a="${action}"]`)?.addEventListener('click', fn);
}
