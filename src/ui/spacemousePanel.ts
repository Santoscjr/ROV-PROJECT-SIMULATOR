import { t } from '../i18n';
import { AXIS_NAMES, type AxisName, type PilotAction } from '../input/types';
import { RAW_AXES, SpaceMouseDevice, type RawAxis, type SpaceMouseConfig } from '../input/spacemouse/spacemouseDevice';
import { buttonBitsFor, buttonName } from '../input/spacemouse/hidParser';

const ACTIONS: (PilotAction | 'none')[] = [
  'none',
  'toggleCamera',
  'toggleLights',
  'lightsUp',
  'lightsDown',
  'camTiltCenter',
  'cycleMode',
  'modeManual',
  'modeStabilize',
  'modeDepthHold',
  'fineControl',
  'confirm',
  'pause',
  'help',
];

const CURVES: { id: string; expo: number }[] = [
  { id: 'linear', expo: 1 },
  { id: 'soft', expo: 1.4 },
  { id: 'fine', expo: 2 },
];

/**
 * SpaceMouse section of the in-simulator settings: connection, calibration,
 * live axes, dead zone, sensitivity, response curve, axis & button mapping.
 * Every change is applied immediately and persisted.
 */
export class SpaceMousePanel {
  readonly el: HTMLElement;
  private raf = 0;
  private unsub: (() => void)[] = [];

  constructor(private readonly sm: SpaceMouseDevice | null) {
    this.el = document.createElement('div');
    this.el.className = 'sm-panel';
    if (sm) {
      this.unsub.push(sm.on('connect', () => this.render()));
      this.unsub.push(sm.on('disconnect', () => this.render()));
    }
    this.render();
  }

  private cfg(): SpaceMouseConfig {
    return this.sm!.getConfig();
  }

  private commit(mut: (c: SpaceMouseConfig) => void): void {
    const c = this.cfg();
    mut(c);
    this.sm!.setConfig(c);
    this.sm!.saveConfig();
  }

  render(): void {
    const sm = this.sm;
    if (!sm) {
      this.el.innerHTML = `<p class="muted">${SpaceMouseDevice.unsupportedReason() ?? t('settings.spacemouseUnsupported')}</p>
        <p><a class="link" href="./spacemouse.html" target="_blank" rel="noopener">${t('sm.openDiag')}</a></p>`;
      return;
    }
    const info = sm.getInfo();
    const c = this.cfg();
    const curve = CURVES.reduce((best, cv) => (Math.abs(cv.expo - c.expo) < Math.abs(best.expo - c.expo) ? cv : best), CURVES[0]);
    const axisOpts = (sel: string) =>
      ['none', ...AXIS_NAMES]
        .map((a) => `<option value="${a}" ${a === sel ? 'selected' : ''}>${a === 'none' ? t('sm.none') : t('axis.' + a)}</option>`)
        .join('');
    const actOpts = (sel: string) => ACTIONS.map((a) => `<option value="${a}" ${a === sel ? 'selected' : ''}>${a === 'none' ? t('sm.none') : t('bind.' + a)}</option>`).join('');
    const layout = info?.layout ?? 'pro';
    const bits = buttonBitsFor(layout === 'generic' ? 'pro' : layout);

    this.el.innerHTML = `
      <div class="sm-status ${sm.connected() ? 'on' : 'off'}">
        <span class="dot"></span>
        <div><strong>${sm.connected() ? info?.name ?? 'SpaceMouse' : t('sm.notConnected')}</strong>
          <div class="muted small">${
            sm.connected()
              ? `VID ${hex(info!.vendorId)} · PID ${hex(info!.productId)} · <span data-o="rate">0</span> ${t('sm.reportsPerSec')}`
              : t('sm.connectHelp')
          }</div></div>
      </div>
      <div class="sm-actions">
        <button data-a="connect" class="${sm.connected() ? '' : 'primary'}">${sm.connected() ? t('sm.change') : t('settings.spacemouseConnect')}</button>
        <button data-a="calibrate" ${sm.connected() ? '' : 'disabled'} title="${t('sm.calibrateTip')}">${t('sm.calibrate')}</button>
        <button data-a="disconnect" ${sm.connected() ? '' : 'disabled'}>${t('sm.disconnect')}</button>
        <a class="btn" href="./spacemouse.html" target="_blank" rel="noopener">${t('sm.openDiag')}</a>
      </div>
      <h3>${t('sm.live')}</h3>
      <div class="sm-live">${['surge', 'sway', 'heave', 'yaw', 'camTilt', 'pitch', 'roll']
        .map((a) => `<div class="sm-bar"><span>${t('axis.' + a)}</span><div class="h"><i data-live="${a}"></i></div></div>`)
        .join('')}</div>
      <h3>${t('sm.response')}</h3>
      <div class="field"><label>${t('sm.deadzone')}</label><span class="ctl"><input type="range" min="0" max="0.4" step="0.01" data-c="deadzone" value="${c.deadzone}"><output>${c.deadzone.toFixed(2)}</output></span></div>
      <div class="field"><label>${t('sm.sensitivity')}</label><span class="ctl"><input type="range" min="0.2" max="2.5" step="0.05" data-c="sensitivity" value="${c.sensitivity}"><output>${c.sensitivity.toFixed(2)}</output></span></div>
      <div class="field"><label>${t('sm.curve')}</label><span class="ctl">
        <select data-c="curve">${CURVES.map((cv) => `<option value="${cv.id}" ${cv.id === curve.id ? 'selected' : ''}>${t('sm.curve.' + cv.id)}</option>`).join('')}</select>
        <input type="range" min="1" max="3" step="0.05" data-c="expo" value="${c.expo}"><output>${c.expo.toFixed(2)}</output></span></div>
      <h3>${t('sm.axes')}</h3>
      <table class="bind-table sm-axes"><tbody>${RAW_AXES.map(
        (a) => `<tr><td>${t('sm.raw.' + a)}</td>
          <td><select data-axis="${a}">${axisOpts(c.axes[a].target)}</select></td>
          <td><label class="small"><input type="checkbox" data-inv="${a}" ${c.axes[a].invert ? 'checked' : ''}> ${t('sm.invert')}</label></td></tr>`,
      ).join('')}</tbody></table>
      <h3>${t('sm.buttons')}</h3>
      <table class="bind-table"><tbody>${bits
        .map((b) => `<tr><td>${buttonName(b, layout === 'generic' ? 'pro' : layout)}</td><td><select data-btn="${b}">${actOpts(c.buttons[String(b)] ?? 'none')}</select></td></tr>`)
        .join('')}</tbody></table>
      <div class="sm-actions"><button data-a="reset">${t('sm.reset')}</button></div>
      <p class="muted small">${t('sm.policy')}</p>`;

    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel);
    q('[data-a="connect"]')?.addEventListener('click', () => void sm.requestAndOpen().then(() => this.render()));
    q('[data-a="disconnect"]')?.addEventListener('click', () => void sm.close().then(() => this.render()));
    q('[data-a="calibrate"]')?.addEventListener('click', () => {
      sm.calibrate();
      sm.saveConfig();
      this.flash(t('sm.calibrated'));
    });
    q('[data-a="reset"]')?.addEventListener('click', () => {
      sm.resetConfig();
      sm.saveConfig();
      this.render();
    });
    this.el.querySelectorAll<HTMLInputElement>('input[type="range"][data-c]').forEach((inp) =>
      inp.addEventListener('input', () => {
        const key = inp.dataset.c as 'deadzone' | 'sensitivity' | 'expo';
        const val = Number(inp.value);
        this.commit((cfg) => (cfg[key] = val));
        (inp.nextElementSibling as HTMLOutputElement).textContent = val.toFixed(2);
      }),
    );
    q<HTMLSelectElement>('select[data-c="curve"]')?.addEventListener('change', (e) => {
      const cv = CURVES.find((x) => x.id === (e.target as HTMLSelectElement).value)!;
      this.commit((cfg) => (cfg.expo = cv.expo));
      this.render();
    });
    this.el.querySelectorAll<HTMLSelectElement>('select[data-axis]').forEach((sel) =>
      sel.addEventListener('change', () => this.commit((cfg) => (cfg.axes[sel.dataset.axis as RawAxis].target = sel.value as AxisName | 'none'))),
    );
    this.el.querySelectorAll<HTMLInputElement>('input[data-inv]').forEach((cb) =>
      cb.addEventListener('change', () => this.commit((cfg) => (cfg.axes[cb.dataset.inv as RawAxis].invert = cb.checked))),
    );
    this.el.querySelectorAll<HTMLSelectElement>('select[data-btn]').forEach((sel) =>
      sel.addEventListener('change', () => this.commit((cfg) => (cfg.buttons[sel.dataset.btn!] = sel.value as PilotAction | 'none'))),
    );
  }

  private flash(msg: string): void {
    const n = document.createElement('div');
    n.className = 'sm-flash';
    n.textContent = msg;
    this.el.prepend(n);
    setTimeout(() => n.remove(), 2200);
  }

  /** Start/stop the live axis display (only while the panel is visible). */
  setVisible(v: boolean): void {
    cancelAnimationFrame(this.raf);
    if (!v || !this.sm) return;
    const tick = () => {
      const sm = this.sm!;
      const m = sm.getMappedAxes();
      this.el.querySelectorAll<HTMLElement>('[data-live]').forEach((i) => {
        const val = sm.connected() ? m[i.dataset.live as AxisName] : 0;
        i.style.left = val >= 0 ? '50%' : `${50 + val * 50}%`;
        i.style.width = `${Math.abs(val) * 50}%`;
      });
      const rate = this.el.querySelector('[data-o="rate"]');
      if (rate) rate.textContent = String(sm.getReportRateHz());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unsub.forEach((u) => u());
  }
}

function hex(n: number): string {
  return '0x' + n.toString(16).padStart(4, '0');
}
