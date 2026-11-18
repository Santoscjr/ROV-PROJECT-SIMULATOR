import type { MonitorSettings, Settings, StationProfileId, StationSnapshot, ViewSource } from './settings';

const mon = (layout: MonitorSettings['layout'], sources: MonitorSettings['sources'], instruments: MonitorSettings['instruments'] = 'compact'): MonitorSettings => ({
  layout,
  sources: ([...sources, 'external', 'tms', 'tether', 'auxiliary'] as ViewSource[]).slice(0, 4),
  locks: [true, true, true, true],
  instruments,
});

/**
 * Built-in station profiles. A profile only arranges sources on windows; it
 * never changes the simulation. Monitor windows still have to be opened by the
 * operator (browsers only open windows from a user action).
 */
export const BUILTIN_PROFILES: Record<Exclude<StationProfileId, 'custom'>, StationSnapshot> = {
  /** One screen, pilot camera; optional second window with sonar + instruments. */
  pilotagem: {
    layout: 'single',
    panels: ['operational', 'sonar', 'tether', 'auxiliary'],
    panelLocks: [false, true, true, true],
    monitors: [mon('dual', ['sonar', 'instruments'])],
  },
  /** TMS operation: Top-Hat mechanism, tether and both ROV cameras, instruments beside. */
  tms: {
    layout: 'quad',
    panels: ['tms', 'tether', 'operational', 'external'],
    panelLocks: [true, true, true, true],
    monitors: [mon('single', ['instruments'], 'hidden')],
  },
  /** Inspection: pilot + auxiliary cameras; sonar and external view on the second window. */
  inspecao: {
    layout: 'dual',
    panels: ['operational', 'auxiliary', 'tether', 'external'],
    panelLocks: [false, true, true, true],
    monitors: [mon('dual', ['sonar', 'external'])],
  },
  /**
   * Offshore control room (three screens): sonar (upper left), instrumentation
   * (upper right) and four cameras on the main screen — tether / TMS on top,
   * pilot / auxiliary below.
   */
  offshore: {
    layout: 'quad',
    panels: ['tether', 'tms', 'operational', 'auxiliary'],
    panelLocks: [true, true, true, true],
    monitors: [mon('single', ['sonar'], 'compact'), mon('single', ['instruments'], 'hidden')],
  },
};

export function stationOf(s: Settings): StationSnapshot {
  return structuredClone({ layout: s.layout, panels: s.panels, panelLocks: s.panelLocks, monitors: s.monitors });
}

/** Settings patch that applies a profile (custom → the saved snapshot, if any). */
export function profilePatch(id: StationProfileId, s: Settings): Partial<Settings> | null {
  const snap = id === 'custom' ? s.customStation : BUILTIN_PROFILES[id];
  if (!snap) return null;
  return { ...structuredClone(snap), stationProfile: id };
}
