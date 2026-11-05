import { t } from '../i18n';
import { VIEW_SOURCES, type ViewSource } from '../config/settings';
import type { Rect } from '../render/station';

/**
 * Frames, titles and source selectors of the station panels (DOM overlay).
 * Panel 0 follows the main camera; panels 1..3 can show any source.
 */
export class StationUi {
  readonly root: HTMLDivElement;
  private frames: HTMLDivElement[] = [];
  onSource: (panel: number, source: ViewSource) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'station';
    parent.appendChild(this.root);
  }

  /** Lay out the panel frames; returns the sonar host element of each panel. */
  layout(rects: Rect[], sources: ViewSource[], mainSource: string): HTMLDivElement[] {
    this.root.hidden = rects.length <= 1;
    while (this.frames.length < rects.length) {
      const i = this.frames.length;
      const f = document.createElement('div');
      f.className = 'st-panel';
      f.innerHTML = `<div class="st-head"><span class="st-idx">${i + 1}</span>${
        i === 0
          ? `<span class="st-main"></span>`
          : `<select aria-label="${t('station.source')}">${VIEW_SOURCES.map((s) => `<option value="${s}">${t('view.' + s)}</option>`).join('')}</select>`
      }</div><div class="st-host"></div>`;
      f.querySelector('select')?.addEventListener('change', (e) => this.onSource(i, (e.target as HTMLSelectElement).value as ViewSource));
      this.root.appendChild(f);
      this.frames.push(f);
    }
    this.frames.forEach((f, i) => {
      const r = rects[i];
      f.hidden = !r || rects.length <= 1;
      if (!r) return;
      Object.assign(f.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const sel = f.querySelector('select');
      if (sel && document.activeElement !== sel) sel.value = sources[i];
      const main = f.querySelector('.st-main');
      if (main) main.textContent = t('view.' + mainSource);
    });
    return this.frames.map((f) => f.querySelector('.st-host') as HTMLDivElement);
  }
}
