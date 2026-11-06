import { t } from '../i18n';
import { VIEW_SOURCES, type ViewSource } from '../config/settings';
import type { Rect } from '../render/station';
import type { Hud, HudData } from './hud';
import { instrumentRows } from '../render/instrumentRows';
import { isCameraSource } from '../render/station';
import { activeAlarms } from './panelOverlay';

/**
 * Frames, titles, source selectors and lock toggles of the station panels (DOM
 * overlay), plus the station strip: a band RESERVED under the panels in
 * multi-panel layouts (mission objective, essential readouts, alarms), so the
 * instrumentation never covers a picture and never disappears.
 */
export class StationUi {
  readonly root: HTMLDivElement;
  private frames: HTMLDivElement[] = [];
  private readonly strip: HTMLDivElement;
  private stripT = 0;
  onSource: (panel: number, source: ViewSource) => void = () => {};
  onLock: (panel: number, locked: boolean) => void = () => {};
  onActivate: (panel: number) => void = () => {};
  private locks: boolean[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'station';
    parent.appendChild(this.root);
    this.strip = document.createElement('div');
    this.strip.className = 'st-strip';
    this.strip.hidden = true;
    this.strip.innerHTML = '<div class="ss-mission"></div><div class="ss-read"></div><div class="ss-alarm"></div>';
    parent.appendChild(this.strip);
  }

  /** Height of the reserved strip (CSS px) — measured, so wrapping on narrow windows is accounted for. */
  get stripHeight(): number {
    return this.strip.hidden ? 0 : Math.max(36, this.strip.offsetHeight || 40);
  }

  frame(i: number): HTMLDivElement | null {
    return this.frames[i] ?? null;
  }

  /** Lay out the panel frames; returns the host element (sonar/instruments) of each panel. */
  layout(rects: Rect[], sources: ViewSource[], locks: boolean[], active: number, layout: string): HTMLDivElement[] {
    // Single layout: the frame (and its source selector) is only shown for
    // sonar/instrumentation; a single camera keeps the full v2 HUD unobstructed.
    const singleCamera = rects.length === 1 && isCameraSource(sources[0]);
    this.root.hidden = rects.length === 0 || singleCamera;
    this.root.dataset.layout = layout;
    this.locks = locks;
    while (this.frames.length < rects.length) {
      const i = this.frames.length;
      const f = document.createElement('div');
      f.className = 'st-panel';
      f.innerHTML = `<div class="st-host"></div><div class="st-head"><span class="st-idx">${i + 1}</span><select aria-label="${t('station.source')}">${VIEW_SOURCES.map(
        (s) => `<option value="${s}">${t('view.' + s)}</option>`,
      ).join('')}</select><button type="button" class="st-lock"></button></div>`;
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
      f.hidden = !r;
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

  /** Station strip content (~10 Hz). */
  updateStrip(d: HudData, visible: boolean): void {
    this.strip.hidden = !visible;
    if (!visible) return;
    const now = performance.now();
    if (now - this.stripT < 100) return;
    this.stripT = now;
    const [mis, read, alarm] = Array.from(this.strip.children) as HTMLDivElement[];
    const step = d.steps.length ? `${Math.min(d.stepIndex + 1, d.steps.length)}/${d.steps.length} ` : '';
    const g = d.guide;
    const cur = g?.steps.find((s) => s.current);
    const check = g && cur ? ` · ${t('guide.title')} ${g.index}/${g.total}: ${cur.label}${cur.detail ? ` (${cur.detail})` : ''}${cur.hint ? ` — ${cur.hint}` : ''}` : '';
    const hold = d.holdProgress !== null && d.holdProgress !== undefined && d.holdProgress > 0 ? ` · ${Math.round(d.holdProgress * 100)}%` : '';
    mis.innerHTML = `<span class="ss-stage">${step}${d.stageLabel}</span><span class="ss-obj">${d.objective}${hold}${check}</span>`;
    mis.title = d.objective;
    read.innerHTML = instrumentRows(d, false)
      .map(([k, v, c]) => `<div${c ? ` class="${c}"` : ''}><span>${k}</span><b>${v}</b></div>`)
      .join('');
    const al = activeAlarms(d);
    alarm.textContent = al.length ? al.slice(0, 2).join(' · ') : `TMS ${d.tms.mode === 'auto' ? 'AUTO' : 'MAN'} · ${t('lars.' + d.larsState)}`;
    alarm.classList.toggle('on', al.length > 0);
  }
}

/**
 * "Instrumentação" source — designed to fill a whole monitor: analog attitude
 * indicator and compass rose, grouped readouts (navigation / vehicle /
 * tether-TMS), active alarms and the navigation plot. Values are the same HUD
 * data as everywhere else (simulated sensors), so all views agree.
 * Its CSS travels with it (INSTRUMENT_CSS) so a monitor window renders it identically.
 */
export class InstrumentPanel {
  readonly root: HTMLDivElement;
  private readonly att: HTMLCanvasElement;
  private readonly rose: HTMLCanvasElement;
  private readonly rd: HTMLDivElement;
  private readonly al: HTMLDivElement;
  private readonly nav: HTMLCanvasElement;
  private timer = 0;

  constructor(doc: Document = document) {
    this.root = doc.createElement('div');
    this.root.className = 'instr';
    this.root.innerHTML = `<div class="ig"><canvas class="ig-att"></canvas><canvas class="ig-rose"></canvas></div><div class="rd"></div><div class="ial"></div><canvas class="inav"></canvas>`;
    this.att = this.root.querySelector('.ig-att')!;
    this.rose = this.root.querySelector('.ig-rose')!;
    this.rd = this.root.querySelector('.rd')!;
    this.al = this.root.querySelector('.ial')!;
    this.nav = this.root.querySelector('.inav')!;
    if (!doc.getElementById('instr-css')) {
      const st = doc.createElement('style');
      st.id = 'instr-css';
      st.textContent = INSTRUMENT_CSS;
      doc.head.appendChild(st);
    }
  }

  update(d: HudData, hud: Hud): void {
    hud.drawNavTo(this.nav, d);
    if (performance.now() - this.timer < 100) return;
    this.timer = performance.now();
    drawAttitude(this.att, d.pitch, d.roll);
    drawRose(this.rose, d.heading, d.headingSetpoint);
    const f = (v: number, n = 1) => v.toFixed(n);
    const sg = (v: number, n = 1) => (v >= 0 ? '+' : '') + v.toFixed(n);
    const hdg = String(Math.round(((d.heading % 360) + 360) % 360) % 360).padStart(3, '0');
    const tm = d.tms;
    const group = (title: string, rows: [string, string, string?][]) =>
      `<section><h4>${title}</h4>${rows.map(([k, v, c]) => `<div${c ? ` class="${c}"` : ''}><span>${k}</span><b>${v}</b></div>`).join('')}</section>`;
    this.rd.innerHTML =
      group(t('instr.nav'), [
        [t('hud.depth'), `${f(Math.max(0, d.depth))} m`],
        [t('hud.altitude'), d.altitude === null ? '---' : `${f(d.altitude)} m`],
        [t('hud.heading'), `${hdg}°`],
        [t('hud.vspeed'), `${sg(d.verticalSpeed, 2)} m/s`],
        [t('hud.speed'), d.dvl ? `${f(Math.hypot(d.dvl.surge, d.dvl.sway), 2)} m/s` : '---'],
        ['X / Z', `${f(d.position.x, 0)} / ${f(d.position.z, 0)} m`],
      ]) +
      group(t('instr.vehicle'), [
        [t('hud.mode'), t('hud.mode.' + d.mode)],
        [t('hud.pitch'), `${sg(d.pitch)}°`],
        [t('hud.roll'), `${sg(d.roll)}°`],
        [t('hud.power'), d.powerFraction === null ? '---' : `${Math.round(d.powerFraction * 100)}%`, d.saturation < 0.95 ? 'warn' : ''],
        [t('hud.lights'), d.lightsOn ? `${Math.round(d.lightLevel * 100)}%` : t('hud.off')],
        [t('hud.camera'), t('view.' + d.camera)],
      ]) +
      group(t('instr.tether'), [
        ['TETHER', `${f(tm.payout)} m`],
        [t('hud.tms.tension'), `${f(tm.tension / 1000, 2)} kN`, tm.tension > tm.tensionWarn ? 'warn' : ''],
        [t('hud.tms.slack'), `${f(tm.slack)} m`, tm.slack > tm.slackWarn ? 'warn' : ''],
        ['TMS', `${tm.mode === 'auto' ? 'AUTO' : 'MAN'} · ${t('hud.tms.state.' + tm.state)}`],
        ['TOP-HAT', t('lars.' + d.larsState)],
        [t('instr.stored'), `${f(tm.stored, 0)} m`],
      ]);
    const al = activeAlarms(d);
    this.al.textContent = al.length ? al.join(' · ') : t('instr.noAlarms');
    this.al.classList.toggle('on', al.length > 0);
  }
}

function fit(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = Math.max(1, c.clientWidth);
  const h = Math.max(1, c.clientHeight);
  const dpr = Math.min(2, c.ownerDocument.defaultView?.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** Artificial horizon: pitch ladder (±30°) and roll scale. */
function drawAttitude(c: HTMLCanvasElement, pitch: number, roll: number): void {
  const f = fit(c);
  if (!f) return;
  const { g, w, h } = f;
  const r = Math.min(w, h) / 2 - 6;
  if (r < 20) return;
  const cx = w / 2;
  const cy = h / 2;
  const ppd = r / 35; // px per degree of pitch
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  g.translate(cx, cy);
  g.rotate((-roll * Math.PI) / 180);
  const yh = pitch * ppd;
  g.fillStyle = '#1d4f6e';
  g.fillRect(-2 * r, -2 * r, 4 * r, 2 * r + yh);
  g.fillStyle = '#5a4528';
  g.fillRect(-2 * r, yh, 4 * r, 2 * r);
  g.strokeStyle = '#e9eff3';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-2 * r, yh);
  g.lineTo(2 * r, yh);
  g.stroke();
  g.font = '10px "IBM Plex Mono", monospace';
  g.fillStyle = '#e9eff3';
  g.textAlign = 'left';
  for (let a = -30; a <= 30; a += 10) {
    if (!a) continue;
    const y = yh - a * ppd;
    g.beginPath();
    g.moveTo(-r * 0.25, y);
    g.lineTo(r * 0.25, y);
    g.stroke();
    g.fillText(String(Math.abs(a)), r * 0.28, y + 3);
  }
  g.restore();
  // Fixed aircraft symbol + roll scale.
  g.strokeStyle = '#f2a93b';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx - r * 0.45, cy);
  g.lineTo(cx - r * 0.12, cy);
  g.lineTo(cx, cy + r * 0.08);
  g.lineTo(cx + r * 0.12, cy);
  g.lineTo(cx + r * 0.45, cy);
  g.stroke();
  g.strokeStyle = '#7d8d99';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  for (const a of [-45, -30, -15, 0, 15, 30, 45]) {
    const t2 = ((a - 90) * Math.PI) / 180;
    g.beginPath();
    g.moveTo(cx + Math.cos(t2) * r, cy + Math.sin(t2) * r);
    g.lineTo(cx + Math.cos(t2) * (r - 8), cy + Math.sin(t2) * (r - 8));
    g.stroke();
  }
  const tr = ((-roll - 90) * Math.PI) / 180;
  g.fillStyle = '#f2a93b';
  g.beginPath();
  g.moveTo(cx + Math.cos(tr) * (r - 10), cy + Math.sin(tr) * (r - 10));
  g.lineTo(cx + Math.cos(tr + 0.08) * (r - 20), cy + Math.sin(tr + 0.08) * (r - 20));
  g.lineTo(cx + Math.cos(tr - 0.08) * (r - 20), cy + Math.sin(tr - 0.08) * (r - 20));
  g.fill();
}

/** Compass rose (heading up), with the heading-hold setpoint bug. */
function drawRose(c: HTMLCanvasElement, heading: number, setpoint: number | null): void {
  const f = fit(c);
  if (!f) return;
  const { g, w, h } = f;
  const r = Math.min(w, h) / 2 - 6;
  if (r < 20) return;
  const cx = w / 2;
  const cy = h / 2;
  g.strokeStyle = '#7d8d99';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.font = `600 ${Math.max(8, Math.min(12, Math.round(r * 0.14)))}px "IBM Plex Mono", monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 10) {
    const t2 = ((a - heading - 90) * Math.PI) / 180;
    const major = a % 30 === 0;
    g.strokeStyle = major ? '#e9eff3' : '#7d8d99';
    g.beginPath();
    g.moveTo(cx + Math.cos(t2) * r, cy + Math.sin(t2) * r);
    g.lineTo(cx + Math.cos(t2) * (r - (major ? 10 : 5)), cy + Math.sin(t2) * (r - (major ? 10 : 5)));
    g.stroke();
    if (major) {
      const lbl = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10);
      g.fillStyle = a % 90 === 0 ? '#f2a93b' : '#e9eff3';
      g.fillText(lbl, cx + Math.cos(t2) * (r * 0.78), cy + Math.sin(t2) * (r * 0.78));
    }
  }
  if (setpoint !== null) {
    const t2 = ((setpoint - heading - 90) * Math.PI) / 180;
    g.fillStyle = '#6cc4d8';
    g.beginPath();
    g.arc(cx + Math.cos(t2) * (r + 1), cy + Math.sin(t2) * (r + 1), 4, 0, Math.PI * 2);
    g.fill();
  }
  // Lubber line + numeric heading.
  g.fillStyle = '#f2a93b';
  g.beginPath();
  g.moveTo(cx, cy - r + 2);
  g.lineTo(cx - 6, cy - r - 6);
  g.lineTo(cx + 6, cy - r - 6);
  g.fill();
  g.font = `600 ${Math.max(10, Math.round(r * 0.26))}px "IBM Plex Mono", monospace`;
  g.fillStyle = '#ffffff';
  g.fillText(`${String(Math.round(((heading % 360) + 360) % 360) % 360).padStart(3, '0')}°`, cx, cy);
}

export const INSTRUMENT_CSS = `
.instr{position:absolute;inset:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr) auto;grid-template-areas:"g rd" "nav rd" "al al";gap:8px 14px;padding:8px 10px;box-sizing:border-box;background:#070c10;font-family:'IBM Plex Mono',ui-monospace,monospace;color:#e9eff3;overflow:hidden;container-type:size}
.instr .ig{grid-area:g;display:grid;grid-template-columns:1fr 1fr;gap:6px;min-height:0}
.instr .ig canvas,.instr .inav{width:100%;height:100%;min-height:0;display:block}
.instr .inav{grid-area:nav}
.instr .rd{grid-area:rd;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 14px;align-content:start;overflow:hidden;min-height:0}
.instr .rd h4{margin:0 0 3px;font-size:10px;letter-spacing:.16em;color:#f2a93b;border-bottom:1px solid #1f2c36;padding-bottom:2px}
.instr .rd div{display:flex;justify-content:space-between;gap:8px;line-height:1.45}
.instr .rd span{font-size:10px;letter-spacing:.1em;color:#7d8d99;white-space:nowrap}
.instr .rd b{font-size:clamp(11px,2.2cqh,16px);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.instr .rd div.warn b{color:#f0b040}
.instr .ial{grid-area:al;font-size:12px;color:#7d8d99}
.instr .ial.on{color:#ffb347;font-weight:600}
@container (max-width: 520px){.instr .rd{grid-template-columns:1fr}}
`;
