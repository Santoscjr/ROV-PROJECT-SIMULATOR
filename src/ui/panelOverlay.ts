import { t } from '../i18n';
import type { HudItems, ViewSource } from '../config/settings';
import type { HudData } from './hud';

/** Camera head state shown in the overlay (from the shared camera state). */
export interface CamReadout {
  pan: number;
  tilt: number;
  zoom: number;
}

const fmt = (v: number, n = 1) => v.toFixed(n);
const sgn = (v: number, n = 1) => (v >= 0 ? '+' : '') + v.toFixed(n);
const pad3 = (v: number) => String(Math.round(((v % 360) + 360) % 360) % 360).padStart(3, '0');

/** Which overlay elements fit a panel of this size (explicit compaction policy). */
export function overlayPolicy(w: number, h: number): { line: 'full' | 'short'; compass: boolean; corners: boolean; raised: boolean } {
  const compass = w >= 260 && h >= 180;
  return {
    line: w >= 520 ? 'full' : 'short',
    compass,
    corners: w >= 420 && h >= 260,
    // Below ~760 px the corner blocks would meet the compass tape: lift them above it.
    raised: compass && w < 760,
  };
}

/** Alarms derived from simulated values (shared by every view). */
export function activeAlarms(d: HudData): string[] {
  const a: string[] = [];
  const tm = d.tms;
  if (tm.tension > tm.tensionWarn) a.push(t('hud.tms.warnTension'));
  if (tm.slack > tm.slackWarn) a.push(t('hud.tms.warnSlack'));
  if (tm.onRov) a.push(t('hud.tms.warnOnRov'));
  if (['limitMax', 'tensionTrip', 'slip'].includes(tm.state)) a.push(t('hud.tms.state.' + tm.state));
  if (d.altitude !== null && d.altitude < 1) a.push(t('hud.alarm.lowAltitude'));
  if (d.saturation < 0.95) a.push(t('hud.alarm.thrustLimit'));
  if (d.warning) a.push(d.warning);
  return a;
}

/**
 * Operational overlay drawn over a camera panel (any panel, any window), like
 * the video overlay of a real pilot station: no boxes over the picture, text
 * with outline shadow, compass tape at the bottom centre.
 */
export class PanelOverlay {
  readonly root: HTMLDivElement;
  private readonly top: HTMLDivElement;
  private readonly alarms: HTMLDivElement;
  private readonly bl: HTMLDivElement;
  private readonly br: HTMLDivElement;
  private readonly compass: HTMLCanvasElement;
  private readonly hdg: HTMLDivElement;
  private last = 0;

  constructor(doc: Document = document) {
    this.root = doc.createElement('div');
    this.root.className = 'pov';
    this.root.innerHTML = `<div class="pov-top"></div><div class="pov-alarm"></div><div class="pov-bl"></div><div class="pov-br"></div><div class="pov-compass"><canvas></canvas><div class="pov-hdg"></div></div>`;
    this.top = this.root.querySelector('.pov-top')!;
    this.alarms = this.root.querySelector('.pov-alarm')!;
    this.bl = this.root.querySelector('.pov-bl')!;
    this.br = this.root.querySelector('.pov-br')!;
    this.compass = this.root.querySelector('canvas')!;
    this.hdg = this.root.querySelector('.pov-hdg')!;
  }

  update(d: HudData, source: ViewSource, cam: CamReadout | null, items: HudItems, w: number, h: number, force = false): void {
    const now = performance.now();
    if (!force && now - this.last < 100) return;
    this.last = now;
    const pol = overlayPolicy(w, h);
    const pilotCam = source === 'operational' || source === 'auxiliary';
    // Top line: depth / altitude / heading (always for pilot cameras; compact on small panels).
    const parts: string[] = [];
    if (items.depth) {
      parts.push(`${t('hud.depth')} <b>${fmt(Math.max(0, d.depth))} m</b>`);
      parts.push(`${t('hud.altitude')} <b>${d.altitude === null ? '---' : fmt(d.altitude) + ' m'}</b>`);
    }
    if (items.compass && !pol.compass) parts.push(`${t('hud.heading')} <b>${pad3(d.heading)}°</b>`);
    if (pol.line === 'full' && items.depth) parts.push(`V <b>${sgn(d.verticalSpeed, 2)} m/s</b>`);
    this.top.innerHTML = parts.join('<span class="sep">·</span>');
    this.top.hidden = parts.length === 0;
    // Alarms (only when present).
    const al = items.alarms ? activeAlarms(d) : [];
    this.alarms.textContent = al.slice(0, pol.corners ? 3 : 1).join(' · ');
    this.alarms.hidden = al.length === 0;
    // Bottom-left: attitude + camera head. Bottom-right: tether.
    const showCorners = pol.corners;
    const bl: string[] = [];
    if (items.attitude) bl.push(`PITCH <b>${sgn(d.pitch)}°</b> ROLL <b>${sgn(d.roll)}°</b>`);
    if (items.camera && cam) bl.push(`${source === 'external' ? 'ÓRBITA' : 'PAN'} <b>${fmt(cam.pan, 0)}°</b> TILT <b>${fmt(cam.tilt, 0)}°</b> ${source === 'external' ? `DIST <b>${fmt(cam.zoom)} m</b>` : `ZOOM <b>${fmt(1 / cam.zoom)}×</b>`}`);
    if (pilotCam && items.camera) bl.push(`${t('hud.mode')} <b>${t('hud.mode.' + d.mode)}</b>`);
    this.bl.innerHTML = bl.join('<br>');
    const cornerBottom = pol.raised ? '52px' : '8px';
    this.bl.style.bottom = cornerBottom;
    this.br.style.bottom = cornerBottom;
    this.bl.hidden = !showCorners || bl.length === 0;
    const tm = d.tms;
    this.br.innerHTML = items.tether
      ? `TETHER <b>${fmt(tm.payout, 1)} m</b><br>${t('hud.tms.tension')} <b class="${tm.tension > tm.tensionWarn ? 'warn' : ''}">${fmt(tm.tension / 1000, 2)} kN</b><br>${t('hud.tms.slack')} <b>${fmt(tm.slack)} m</b>`
      : '';
    this.br.hidden = !showCorners || !items.tether;
    // Compass tape (bottom centre).
    const cbox = this.compass.parentElement as HTMLElement;
    cbox.hidden = !(items.compass && pol.compass);
    if (!cbox.hidden) {
      this.drawCompass(d.heading, Math.min(260, Math.max(150, w * 0.32)));
      this.hdg.textContent = `${pad3(d.heading)}°`;
    }
  }

  private drawCompass(heading: number, cssW: number): void {
    const c = this.compass;
    const dpr = Math.min(2, c.ownerDocument.defaultView?.devicePixelRatio || 1);
    const cssH = 26;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const span = 90; // degrees shown across the tape
    const pxPerDeg = cssW / span;
    g.lineWidth = 1;
    g.font = '600 10px "IBM Plex Mono", monospace';
    g.textAlign = 'center';
    g.shadowColor = 'rgba(0,0,0,0.9)';
    g.shadowBlur = 2;
    const start = Math.floor((heading - span / 2) / 5) * 5;
    for (let a = start; a <= heading + span / 2; a += 5) {
      const x = cssW / 2 + (a - heading) * pxPerDeg;
      const major = a % 15 === 0;
      g.strokeStyle = 'rgba(235,242,246,0.9)';
      g.beginPath();
      g.moveTo(x, cssH);
      g.lineTo(x, cssH - (major ? 9 : 5));
      g.stroke();
      if (major) {
        const n = ((a % 360) + 360) % 360;
        const lbl = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : String(n).padStart(3, '0');
        g.fillStyle = n % 90 === 0 ? '#f2a93b' : 'rgba(235,242,246,0.95)';
        g.fillText(lbl, x, 10);
      }
    }
    g.fillStyle = '#f2a93b';
    g.beginPath();
    g.moveTo(cssW / 2 - 5, cssH);
    g.lineTo(cssW / 2 + 5, cssH);
    g.lineTo(cssW / 2, cssH - 7);
    g.fill();
  }
}

/** CSS for the overlay (main window stylesheet and injected into monitor windows). */
export const PANEL_OVERLAY_CSS = `
.pov{position:absolute;inset:0;pointer-events:none;font-family:'IBM Plex Mono',ui-monospace,monospace;color:#e8eef2;text-shadow:0 0 2px #000,0 1px 2px #000,0 0 4px rgba(0,0,0,.8);font-size:11px;line-height:1.35}
.pov b{font-weight:600;color:#fff}
.pov b.warn{color:#f0b040}
.pov .sep{margin:0 7px;color:#9fb0bb}
.pov-top{position:absolute;top:36px;left:50%;transform:translateX(-50%);white-space:nowrap;letter-spacing:.04em}
.pov-alarm{position:absolute;top:54px;left:50%;transform:translateX(-50%);white-space:nowrap;color:#ffb347;font-weight:600;letter-spacing:.06em}
.pov-bl{position:absolute;left:8px;bottom:8px}
.pov-br{position:absolute;right:8px;bottom:8px;text-align:right}
.pov-compass{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center}
.pov-compass canvas{display:block}
.pov-hdg{font-weight:600;font-size:12px;color:#fff}
.pov [hidden],.pov[hidden]{display:none}
`;
