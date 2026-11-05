import { t } from '../i18n';
import { VIEW_SOURCES, type ViewSource } from '../config/settings';
import type { Rect } from '../render/station';
import type { Hud, HudData } from './hud';

/**
 * Frames, titles, source selectors and lock toggles of the station panels (DOM
 * overlay). The active panel (target of camera commands) is highlighted.
 */
export class StationUi {
  readonly root: HTMLDivElement;
  private frames: HTMLDivElement[] = [];
  onSource: (panel: number, source: ViewSource) => void = () => {};
  onLock: (panel: number, locked: boolean) => void = () => {};
  onActivate: (panel: number) => void = () => {};
  private locks: boolean[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'station';
    parent.appendChild(this.root);
  }

  /** Lay out the panel frames; returns the host element (sonar/instruments) of each panel. */
  layout(rects: Rect[], sources: ViewSource[], locks: boolean[], active: number): HTMLDivElement[] {
    this.root.hidden = rects.length <= 1;
    this.locks = locks;
    while (this.frames.length < rects.length) {
      const i = this.frames.length;
      const f = document.createElement('div');
      f.className = 'st-panel';
      f.innerHTML = `<div class="st-head"><span class="st-idx">${i + 1}</span><select aria-label="${t('station.source')}">${VIEW_SOURCES.map(
        (s) => `<option value="${s}">${t('view.' + s)}</option>`,
      ).join('')}</select><button type="button" class="st-lock"></button></div><div class="st-host"></div>`;
      const sel = f.querySelector('select') as HTMLSelectElement;
      sel.addEventListener('change', () => {
        this.onSource(i, sel.value as ViewSource);
        // Give the keyboard back to the pilot: arrows must drive the winch, not this list.
        sel.blur();
      });
      const lock = f.querySelector('.st-lock') as HTMLButtonElement;
      lock.addEventListener('click', () => {
        this.onLock(i, !this.locks[i]);
        lock.blur();
      });
      f.querySelector('.st-head')?.addEventListener('pointerdown', () => this.onActivate(i));
      this.root.appendChild(f);
      this.frames.push(f);
    }
    this.frames.forEach((f, i) => {
      const r = rects[i];
      f.hidden = !r || rects.length <= 1;
      if (!r) return;
      Object.assign(f.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      f.classList.toggle('active', i === active);
      f.classList.toggle('locked', !!locks[i]);
      const sel = f.querySelector('select') as HTMLSelectElement;
      if (document.activeElement !== sel && sel.value !== sources[i]) sel.value = sources[i];
      sel.disabled = !!locks[i];
      const lock = f.querySelector('.st-lock') as HTMLButtonElement;
      const lbl = t(locks[i] ? 'station.lockedShort' : 'station.freeShort');
      if (lock.textContent !== lbl) {
        lock.textContent = lbl;
        lock.title = t(locks[i] ? 'station.unlock' : 'station.lock');
        lock.setAttribute('aria-pressed', String(!!locks[i]));
      }
    });
    return this.frames.map((f) => f.querySelector('.st-host') as HTMLDivElement);
  }
}

/**
 * "Instrumentação" panel source: large readouts of the essential data plus the
 * navigation display, all from the same HUD data (simulation values).
 */
export class InstrumentPanel {
  readonly root: HTMLDivElement;
  private readonly rd: HTMLDivElement;
  private readonly nav: HTMLCanvasElement;
  private timer = 0;

  constructor(doc: Document = document) {
    this.root = doc.createElement('div');
    this.root.className = 'instr';
    this.rd = doc.createElement('div');
    this.rd.className = 'rd';
    this.nav = doc.createElement('canvas');
    this.root.append(this.rd, this.nav);
  }

  update(d: HudData, hud: Hud): void {
    hud.drawNavTo(this.nav, d);
    if (performance.now() - this.timer < 100) return;
    this.timer = performance.now();
    const f = (v: number, n = 1) => v.toFixed(n);
    const hdg = String(Math.round(((d.heading % 360) + 360) % 360) % 360).padStart(3, '0');
    const rows: [string, string][] = [
      [t('hud.depth'), `${f(Math.max(0, d.depth))} m`],
      [t('hud.altitude'), d.altitude === null ? '---' : `${f(d.altitude)} m`],
      [t('hud.heading'), `${hdg}°`],
      [t('hud.pitch'), `${f(d.pitch)}°`],
      [t('hud.roll'), `${f(d.roll)}°`],
      [t('hud.vspeed'), `${f(d.verticalSpeed, 2)} m/s`],
      [t('hud.speed'), d.dvl ? `${f(Math.hypot(d.dvl.surge, d.dvl.sway), 2)} m/s` : '---'],
      [t('hud.mode'), t('hud.mode.' + d.mode)],
      [t('hud.lights'), d.lightsOn ? `${Math.round(d.lightLevel * 100)}%` : t('hud.off')],
      ['TETHER', `${f(d.tms.payout)} m`],
      [t('hud.tms.tension'), `${f(d.tms.tension / 1000, 2)} kN`],
      [t('hud.tms.slack'), `${f(d.tms.slack)} m`],
      ['TOP-HAT', t('lars.' + d.larsState)],
      [t('hud.power'), d.powerFraction === null ? '---' : `${Math.round(d.powerFraction * 100)}%`],
      [t('hud.camera'), t('view.' + d.camera)],
    ];
    this.rd.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }
}
