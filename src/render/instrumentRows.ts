import { t } from '../i18n';
import type { HudData } from '../ui/hud';

const fmt = (v: number, n = 1) => v.toFixed(n);
const pad3 = (v: number) => String(Math.round(((v % 360) + 360) % 360) % 360).padStart(3, '0');

/** Essential readouts shared by the monitor instrument bar (compact = one row). */
export function instrumentRows(d: HudData, full: boolean): [string, string, string?][] {
  const tm = d.tms;
  const rows: [string, string, string?][] = [
    [t('hud.depth'), `${fmt(Math.max(0, d.depth))} m`],
    [t('hud.altitude'), d.altitude === null ? '---' : `${fmt(d.altitude)} m`],
    [t('hud.heading'), `${pad3(d.heading)}°`],
    [t('hud.pitch'), `${fmt(d.pitch)}°`],
    [t('hud.roll'), `${fmt(d.roll)}°`],
    [t('hud.speed'), d.dvl ? `${fmt(Math.hypot(d.dvl.surge, d.dvl.sway), 2)} m/s` : '---'],
    [t('hud.mode'), t('hud.mode.' + d.mode)],
    ['TETHER', `${fmt(tm.payout, 0)} m · ${fmt(tm.tension / 1000, 1)} kN`, tm.tension > tm.tensionWarn || tm.slack > tm.slackWarn ? 'warn' : ''],
  ];
  if (full)
    rows.push(
      [t('hud.vspeed'), `${fmt(d.verticalSpeed, 2)} m/s`],
      [t('hud.tms.slack'), `${fmt(tm.slack)} m`],
      ['TMS', `${tm.mode === 'auto' ? 'AUTO' : 'MAN'} · ${t('hud.tms.state.' + tm.state)}`],
      ['TOP-HAT', t('lars.' + d.larsState)],
      [t('hud.lights'), d.lightsOn ? `${Math.round(d.lightLevel * 100)}%` : t('hud.off')],
    );
  return rows;
}
