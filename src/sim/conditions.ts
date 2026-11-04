/**
 * Environmental conditions shared by physics, rendering and missions.
 *
 * The pilot chooses one option per category in Settings; a mission may
 * override categories (e.g. the adverse-conditions mission forces strong
 * current and turbid water). Every field drives the simulation or the
 * optics — none is purely cosmetic.
 */

export type CurrentLevel = 'off' | 'low' | 'normal' | 'strong';
export type VisibilityLevel = 'clear' | 'normal' | 'turbid';
export type LightLevel = 'day' | 'overcast' | 'night';
export type SeaState = 'calm' | 'moderate';

export interface ConditionChoice {
  current: CurrentLevel;
  visibility: VisibilityLevel;
  light: LightLevel;
  sea: SeaState;
}

export const DEFAULT_CONDITIONS: ConditionChoice = { current: 'normal', visibility: 'normal', light: 'day', sea: 'calm' };

export interface EnvironmentConditions {
  choice: ConditionChoice;
  current: {
    /** Multiplier of the reference current profile (0 = slack water). */
    speedScale: number;
    /** Amplitude of slow fluctuations, fraction of the mean speed. */
    gustiness: number;
    /** Rotation applied to the reference current direction (deg). */
    headingOffsetDeg: number;
  };
  water: {
    /** Extra beam extinction added to all channels (1/m): suspended sediment / plankton. */
    turbidity: number;
    /** Multiplier on the number/brightness of suspended particles. */
    particleDensity: number;
    /** Extra extinction near the seabed (1/m) from resuspended sediment. */
    nearBottomTurbidity: number;
  };
  light: {
    /** Multiplier of surface irradiance (1 = clear day). */
    surfaceIrradiance: number;
  };
  sea: {
    /** Significant wave height (m): surface rendering and heave of the vehicle near the surface. */
    waveHeight: number;
    /** Typical wave period (s). */
    wavePeriod: number;
  };
}

const CURRENT: Record<CurrentLevel, EnvironmentConditions['current']> = {
  off: { speedScale: 0, gustiness: 0, headingOffsetDeg: 0 },
  low: { speedScale: 0.5, gustiness: 0.12, headingOffsetDeg: 0 },
  normal: { speedScale: 1, gustiness: 0.18, headingOffsetDeg: 0 },
  strong: { speedScale: 2.1, gustiness: 0.3, headingOffsetDeg: 25 },
};

const WATER: Record<VisibilityLevel, EnvironmentConditions['water']> = {
  clear: { turbidity: 0, particleDensity: 0.6, nearBottomTurbidity: 0.02 },
  normal: { turbidity: 0.035, particleDensity: 1, nearBottomTurbidity: 0.035 },
  turbid: { turbidity: 0.2, particleDensity: 2.2, nearBottomTurbidity: 0.08 },
};

const LIGHT: Record<LightLevel, EnvironmentConditions['light']> = {
  day: { surfaceIrradiance: 1 },
  overcast: { surfaceIrradiance: 0.35 },
  night: { surfaceIrradiance: 0.004 },
};

const SEA: Record<SeaState, EnvironmentConditions['sea']> = {
  calm: { waveHeight: 0.6, wavePeriod: 6 },
  moderate: { waveHeight: 2.0, wavePeriod: 8 },
};

/** Resolve a set of choices (with optional mission overrides) into parameters. */
export function resolveConditions(choice: ConditionChoice, override?: Partial<ConditionChoice>): EnvironmentConditions {
  const c: ConditionChoice = { ...choice, ...(override ?? {}) };
  return {
    choice: c,
    current: { ...CURRENT[c.current] },
    water: { ...WATER[c.visibility] },
    light: { ...LIGHT[c.light] },
    sea: { ...SEA[c.sea] },
  };
}

/** Approximate horizontal visibility (m) for the green channel, for display/help. */
export function visibilityRange(cond: EnvironmentConditions, baseExtinctionGreen = 0.1): number {
  // Distance at which contrast drops to ~2 % (Koschmieder-like, ln 50 ≈ 3.9).
  return 3.9 / (baseExtinctionGreen + cond.water.turbidity);
}
