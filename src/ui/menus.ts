import { t } from '../i18n';
import {
  BINDABLE,
  KEYBOARD_PRESETS,
  type Bindable,
  type GraphicsQuality,
  type KeyboardPreset,
  type Settings,
  type SettingsStore,
} from '../config/settings';
import type { MissionStats } from '../mission/mission';
import type { CurrentLevel } from '../sim/ocean';
import type { PilotMode } from '../control/rovController';

type ScreenName = 'main' | 'pause' | 'settings' | 'help' | 'report' | null;

export interface MenuCallbacks {
  start(): void;
  resume(): void;
  restart(): void;
  mainMenu(): void;
  connectSpaceMouse(): Promise<string | null>;
  spaceMouseSupported(): boolean;
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

export class Menus {
  readonly root: HTMLDivElement;
  private screens: Record<Exclude<ScreenName, null>, HTMLElement>;
  current: ScreenName = 'main';
  private settingsReturn: ScreenName = 'main';
  private listening: { key: Bindable; btn: HTMLButtonElement } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly store: SettingsStore,
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
    };
    Object.values(this.screens).forEach((s) => this.root.appendChild(s));
    window.addEventListener('keydown', this.onKeyCapture, true);
    store.subscribe(() => this.refreshSettings());
    this.show('main');
  }

  get open(): boolean {
    return this.current !== null;
  }

  show(name: ScreenName): void {
    if (name === 'settings' && this.current !== 'settings') this.settingsReturn = this.current;
    if (name === 'help' && this.current !== 'help') this.settingsReturn = this.current;
    this.current = name;
    for (const [k, el] of Object.entries(this.screens)) el.hidden = k !== name;
    if (name === 'settings') this.refreshSettings();
    if (name) (this.screens[name].querySelector('button.primary, button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  back(): void {
    this.show(this.settingsReturn);
  }

  // ---------- Main menu ----------
  private buildMain(): HTMLElement {
    const s = screen();
    s.innerHTML = `
      <div class="card">
        <div class="menu-grid">
          <section>
            <div class="brand">${LOGO}<div><div class="eyebrow">Offshore ROV Operations</div>
              <h1>${t('app.title')}</h1><div class="sub">${t('app.subtitle')}</div></div></div>
            <dl class="facts">
              <dt>${t('menu.mission')}</dt><dd><strong>${t('menu.missionName')}</strong><br><span class="muted">${t('menu.missionDesc')}</span></dd>
              <dt>${t('menu.vehicle')}</dt><dd>${t('menu.vehicleDesc')}</dd>
              <dt>${t('menu.site')}</dt><dd>${t('menu.siteDesc')}</dd>
            </dl>
            <ol class="steps">
              <li>${t('stage.prep')} — ${t('mission.prep.title')}</li>
              <li>${t('stage.launch')} · ${t('stage.descent')} · ${t('stage.bottom')}</li>
              <li>${t('stage.inspection')} — IP-01, IP-02</li>
              <li>${t('stage.return')} · ${t('stage.recovery')}</li>
            </ol>
          </section>
          <section>
            <div class="menu-actions">
              <button class="primary" data-a="start">${t('menu.start')}</button>
              <button data-a="controls">${t('menu.controls')}</button>
              <button data-a="settings">${t('menu.settings')}</button>
              <button data-a="spacemouse">${t('menu.spacemouse')}</button>
            </div>
            <p class="disclaimer">${t('menu.disclaimer')}</p>
            <div class="keys" style="margin-top:14px">
              <span><kbd>W</kbd> <kbd>S</kbd></span><span>${t('axis.surge')}</span>
              <span><kbd>A</kbd> <kbd>D</kbd></span><span>${t('axis.sway')}</span>
              <span><kbd>Q</kbd> <kbd>E</kbd></span><span>${t('axis.yaw')}</span>
              <span><kbd>R</kbd> <kbd>F</kbd></span><span>${t('axis.heave')}</span>
            </div>
          </section>
        </div>
      </div>`;
    on(s, 'start', () => this.cb.start());
    on(s, 'controls', () => this.show('help'));
    on(s, 'settings', () => this.show('settings'));
    on(s, 'spacemouse', () => window.open('./spacemouse.html', '_blank', 'noopener'));
    return s;
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
            <h3>${t('help.modes')}</h3>
            <p class="help-text">${t('help.modeManual')}</p>
            <p class="help-text">${t('help.modeStabilize')}</p>
            <p class="help-text">${t('help.modeDepthHold')}</p>
            <h3 style="margin-top:18px">${t('help.mouse')}</h3>
            <p class="help-text">${t('help.mouseOp')}</p>
            <p class="help-text">${t('help.mouseExt')}</p>
            <h3 style="margin-top:18px">${t('help.gamepad')}</h3>
            <p class="help-text">${t('help.gamepadDesc')}</p>
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
    s.innerHTML = `
      <div class="card">
        <header><h2>${t('settings.title')}</h2><button data-a="back">${t('menu.back')}</button></header>
        <div class="body settings-grid">
          <div>
            <h3>${t('settings.graphics')}</h3>
            <div class="field"><label for="s-gfx">${t('settings.graphics')}</label>
              <select id="s-gfx" data-s="graphics">
                ${(['low', 'medium', 'high'] as GraphicsQuality[]).map((q) => `<option value="${q}">${t('settings.graphics.' + q)}</option>`).join('')}
              </select></div>
            <div class="field"><label for="s-fps">${t('settings.fps')}</label><input id="s-fps" type="checkbox" data-s="showFps"></div>
            <div class="field"><label for="s-vol">${t('settings.volume')}</label><span class="ctl"><input id="s-vol" type="range" min="0" max="1" step="0.05" data-s="volume"><output data-o="volume"></output></span></div>
            <p class="muted" style="font-size:12px">${t('settings.restartNote')}</p>
            <h3 style="margin-top:18px">${t('menu.mission')}</h3>
            <div class="field"><label for="s-cur">${t('settings.current')}</label>
              <select id="s-cur" data-s="current">${(['off', 'low', 'normal', 'strong'] as CurrentLevel[])
                .map((c) => `<option value="${c}">${t('settings.current.' + c)}</option>`)
                .join('')}</select></div>
            <div class="field"><label for="s-mode">${t('settings.mode')}</label>
              <select id="s-mode" data-s="defaultMode">${(['manual', 'stabilize', 'depthHold'] as PilotMode[])
                .map((m) => `<option value="${m}">${t('hud.mode.' + m)}</option>`)
                .join('')}</select></div>
            <h3 style="margin-top:18px">${t('settings.spacemouse')}</h3>
            <div class="field"><span data-o="smStatus" class="muted"></span><button data-a="sm">${t('settings.spacemouseConnect')}</button></div>
          </div>
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
            <div class="field"><label for="s-lay">${t('settings.layout')}</label>
              <select id="s-lay" data-s="keyboardPreset">${(['wasd', 'arrows'] as KeyboardPreset[])
                .map((p) => `<option value="${p}">${t('settings.layout.' + p)}</option>`)
                .join('')}</select></div>
            <h3 style="margin-top:18px">${t('settings.bindings')}</h3>
            <table class="bind-table"><tbody data-o="binds"></tbody></table>
          </div>
        </div>
        <footer><button data-a="reset">${t('settings.resetDefaults')}</button><button class="primary" data-a="back">${t('menu.back')}</button></footer>
      </div>`;
    s.querySelectorAll<HTMLElement>('[data-a="back"]').forEach((b) => b.addEventListener('click', () => this.back()));
    on(s, 'reset', () => this.store.reset());
    on(s, 'sm', async () => {
      const name = await this.cb.connectSpaceMouse();
      const out = s.querySelector('[data-o="smStatus"]')!;
      out.textContent = name ?? '—';
    });
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
    s.querySelectorAll<HTMLInputElement>('[data-inv]').forEach((cb) =>
      cb.addEventListener('change', () => {
        const inv = { ...this.store.get().invert, [cb.dataset.inv!]: cb.checked };
        this.store.update({ invert: inv });
      }),
    );
    return s;
  }

  private refreshSettings(): void {
    const s = this.screens?.settings;
    if (!s) return;
    const v = this.store.get();
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((input) => {
      const val = v[input.dataset.s as keyof Settings];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!val;
      else if (document.activeElement !== input) input.value = String(val);
    });
    s.querySelectorAll<HTMLOutputElement>('output[data-o]').forEach((o) => {
      const val = v[o.dataset.o as keyof Settings];
      if (typeof val === 'number') o.textContent = val.toFixed(2);
    });
    s.querySelectorAll<HTMLInputElement>('[data-inv]').forEach((cb) => {
      cb.checked = v.invert[cb.dataset.inv as keyof Settings['invert']];
    });
    const sm = s.querySelector('[data-o="smStatus"]')!;
    if (!this.cb.spaceMouseSupported()) {
      sm.textContent = t('settings.spacemouseUnsupported');
      (s.querySelector('[data-a="sm"]') as HTMLButtonElement).disabled = true;
    }
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
    s.innerHTML = `<div class="card" style="max-width:640px"></div>`;
    return s;
  }

  showReport(stats: MissionStats, opts: { totalPoints: number; condition: 'ok' | 'minor' | 'damage'; completed: boolean }): void {
    const card = this.screens.report.querySelector('.card')!;
    const time = (stats.endTime ?? 0) - (stats.startTime ?? 0);
    const mm = Math.floor(time / 60);
    const ss = Math.floor(time % 60);
    const hardest = stats.collisions.reduce((m, c) => Math.max(m, c.speed), 0);
    const cond = { ok: ['report.state.ok', 'status-ok'], minor: ['report.state.minor', 'status-warn'], damage: ['report.state.damage', 'status-alarm'] }[
      opts.condition
    ];
    const done = stats.inspections.length >= opts.totalPoints;
    card.innerHTML = `
      <header><h2>${t('report.title')}</h2><span class="eyebrow">${t('menu.missionName')}</span></header>
      <div class="body">
        <table class="report-table">
          <tr><th>${t('report.time')}</th><td>${mm} min ${String(ss).padStart(2, '0')} s</td></tr>
          <tr><th>${t('report.maxDepth')}</th><td>${stats.maxDepth.toFixed(1)} m</td></tr>
          <tr><th>${t('report.distance')}</th><td>${stats.distance.toFixed(0)} m</td></tr>
          <tr><th>${t('report.objective')}</th><td class="${done ? 'status-ok' : 'status-warn'}">${
            done ? t('report.objective.done') : t('report.objective.partial', { n: stats.inspections.length, total: opts.totalPoints })
          }</td></tr>
          <tr><th>${t('report.inspections')}</th><td>${
            stats.inspections.map((i) => `${i.id} · ${i.range.toFixed(1)} m · ${i.offAxis.toFixed(0)}°`).join('<br>') || '—'
          }</td></tr>
          <tr><th>${t('report.collisions')}</th><td>${stats.collisions.length}${
            hardest > 0 ? ` · ${t('report.hardest')} ${hardest.toFixed(2)} m/s` : ''
          }</td></tr>
          <tr><th>${t('report.state')}</th><td class="${cond[1]}">${t(cond[0])}</td></tr>
        </table>
      </div>
      <footer><button data-a="main">${t('menu.mainMenu')}</button><button class="primary" data-a="new">${t('report.new')}</button></footer>`;
    on(card as HTMLElement, 'main', () => this.cb.mainMenu());
    on(card as HTMLElement, 'new', () => this.cb.restart());
    this.show('report');
  }
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
