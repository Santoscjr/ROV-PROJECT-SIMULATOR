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
    /** Jerlov-type class of the water at the work site (documentation / UI). */
    jerlov: string;
    /**
     * Beam attenuation c = a + b (1/m) for R, G, B at the work depth: what
     * makes a scene fade with viewing (and lamp) distance. Red is dominated by
     * water absorption, blue by CDOM/phytoplankton absorption in coastal water,
     * all channels by particle scattering as turbidity grows.
     */
    beamC: [number, number, number];
    /** Single-scattering albedo b/c (green): brightness of the veil / lamp backscatter. */
    albedo: number;
    /** Diffuse attenuation Kd (1/m) of the water column for sunlight, R, G, B. */
    kd: [number, number, number];
    /** Extra green beam extinction over the clear-water reference (1/m) — legacy scalar. */
    turbidity: number;
    /** Multiplier on the number/brightness of suspended particles (marine snow). */
    particleDensity: number;
    /** Extra extinction near the seabed (1/m): nepheloid layer of fine sediment. */
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

/**
 * Water presets (Jerlov-type; values of the order of the literature, see
 * docs/PESQUISA_TECNICA.md item 18 — beam c ≈ a_w + a_CDOM/phyto + b_p):
 *  - clear:  oceanic IB–II over the shelf break, b_p ≈ 0.05 → c_G ≈ 0.11, ~35 m;
 *  - normal: shelf water, moderately turbid (coastal 1–3), b_p ≈ 0.13 → ~20 m;
 *  - turbid: coastal 5–9 / strong nepheloid layer, b_p ≈ 0.45 → ~6–7 m.
 * Sunlight (Kd) uses the column above, clearer than the near-bottom layer.
 */
const WATER: Record<VisibilityLevel, EnvironmentConditions['water']> = {
  clear: { jerlov: 'IB–II', beamC: [0.37, 0.11, 0.095], albedo: 0.55, kd: [0.36, 0.058, 0.036], turbidity: 0, particleDensity: 0.55, nearBottomTurbidity: 0.01 },
  normal: { jerlov: 'costeira 1–3', beamC: [0.45, 0.18, 0.2], albedo: 0.7, kd: [0.38, 0.072, 0.058], turbidity: 0.07, particleDensity: 1, nearBottomTurbidity: 0.025 },
  turbid: { jerlov: 'costeira 5–9', beamC: [0.85, 0.55, 0.63], albedo: 0.84, kd: [0.43, 0.1, 0.1], turbidity: 0.44, particleDensity: 1.8, nearBottomTurbidity: 0.08 },
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
    water: {
      ...WATER[c.visibility],
      beamC: [...WATER[c.visibility].beamC] as [number, number, number],
      kd: [...WATER[c.visibility].kd] as [number, number, number],
    },
    light: { ...LIGHT[c.light] },
    sea: { ...SEA[c.sea] },
  };
}

/**
 * Approximate horizontal visibility (m) in the green channel near the seabed,
 * for display/help: distance at which the contrast of a dark target drops to
 * ~2 % (Koschmieder-like, ln 50 ≈ 3.9). `baseExtinctionGreen` (legacy) adds
 * the scalar turbidity to that base instead of using the preset's beam c.
 */
export function visibilityRange(cond: EnvironmentConditions, baseExtinctionGreen?: number): number {
  if (baseExtinctionGreen !== undefined) return 3.9 / (baseExtinctionGreen + cond.water.turbidity);
  return 3.9 / (cond.water.beamC[1] + cond.water.nearBottomTurbidity);
}
