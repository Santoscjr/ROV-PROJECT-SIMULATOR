import { Color, Vector3 } from 'three';
import { DEFAULT_CONDITIONS, resolveConditions, type EnvironmentConditions } from '../sim/conditions';
import type { SedimentCloud } from '../sim/sedimentCloud';

/**
 * Simplified spectral optics of sea water (three channels).
 *
 * Diffuse attenuation Kd governs how sunlight fades with depth; beam
 * attenuation c = a + b governs how a scene fades with viewing (and lamp)
 * distance. The per-preset values live in `conditions.ts` (Jerlov-type
 * classes); the constants below are the "normal" preset, used as the
 * reference and as initial uniform values.
 */
const REF = resolveConditions(DEFAULT_CONDITIONS).water;
export const OPTICS = {
  /** Diffuse attenuation of downwelling sunlight (1/m) for R, G, B (reference water). */
  kd: REF.kd as readonly [number, number, number],
  /** Beam extinction for imaging (1/m) for R, G, B (reference water). */
  extinction: REF.beamC as readonly [number, number, number],
  /** Additional extinction near the seabed from suspended sediment (1/m). */
  turbidityNearBottom: REF.nearBottomTurbidity,
  /** Colour of light scattered by the water column at the surface (reference water). */
  scatterColor: new Color(0.085, 0.33, 0.39),
  /** Legacy scalar turbidity of the reference water (see EnvironmentConditions.water.turbidity). */
  referenceTurbidity: REF.turbidity,
  /** Scattering coefficient b (green, 1/m) of the reference water. */
  referenceScattering: REF.beamC[1] * REF.albedo,
};

/** Fraction of surface sunlight per channel reaching `depth` metres. */
export function sunTransmission(depth: number, out = new Color(), extraKd = 0): Color {
  const d = Math.max(0, depth);
  return out.setRGB(
    Math.exp(-(OPTICS.kd[0] + extraKd) * d),
    Math.exp(-(OPTICS.kd[1] + extraKd) * d),
    Math.exp(-(OPTICS.kd[2] + extraKd) * d),
  );
}

/**
 * Optical state of the water derived from the environmental conditions. Every
 * consumer (composite, particles, beams, plume, lighting) reads the same
 * numbers so the image stays physically consistent — and every camera panel
 * of every window uses the same instance (World.waterOptics).
 */
export interface WaterOptics {
  /** Jerlov-type class (label). */
  jerlov: string;
  /** Beam extinction c (1/m) per channel, including turbidity. */
  ext: [number, number, number];
  /** Diffuse attenuation Kd (1/m) per channel. */
  kd: [number, number, number];
  /** Extra Kd over the reference (1/m, G/B mean) — for sunTransmission. */
  extraKd: number;
  /** Green beam extinction relative to the reference water (1/m, may be negative). */
  extraTurbidity: number;
  /** Single-scattering albedo b/c. */
  albedo: number;
  /** In-scattered radiance at the surface (already scaled by irradiance). */
  scatter: Color;
  /** Extra extinction near the seabed (1/m). */
  nearBottom: number;
  /** Surface irradiance multiplier (1 = clear day). */
  irradiance: number;
  /** 0 = direct sun, 1 = fully diffuse sky (overcast / night). */
  overcast: number;
  /** Multiplier on suspended particle count (preset; the settings multiplier is applied in WaterEffects). */
  particleDensity: number;
  /** Scattering coefficient relative to the reference water (b/b_ref): lamp backscatter. */
  scattering: number;
  /** Approximate visibility (m, green, near the seabed). */
  visibility: number;
  waveHeight: number;
  wavePeriod: number;
}

const CLEAR_HUE = new Color(0.05, 0.3, 0.45);
const SEDIMENT_HUE = new Color(0.15, 0.37, 0.29);

export function waterOptics(c: EnvironmentConditions | null): WaterOptics {
  const w = c ? c.water : REF;
  const ext = [...w.beamC] as [number, number, number];
  const kd = [...w.kd] as [number, number, number];
  const b = ext[1] * w.albedo;
  const irradiance = c ? c.light.surfaceIrradiance : 1;
  // Veil hue: blue in clear oceanic water, green → olive as particles and CDOM
  // grow; brighter with the albedo (more scattering per unit attenuation).
  const s = Math.min(1, Math.max(0, (b - 0.06) / 0.4));
  const scatter = CLEAR_HUE.clone()
    .lerp(SEDIMENT_HUE, Math.sqrt(s))
    .multiplyScalar((0.85 + 0.5 * s) * irradiance);
  return {
    jerlov: w.jerlov,
    ext,
    kd,
    extraKd: (kd[1] - OPTICS.kd[1] + kd[2] - OPTICS.kd[2]) / 2,
    extraTurbidity: ext[1] - OPTICS.extinction[1],
    albedo: w.albedo,
    scatter,
    nearBottom: w.nearBottomTurbidity,
    irradiance,
    overcast: Math.min(1, Math.max(0, (1 - irradiance) / 0.65)),
    particleDensity: w.particleDensity,
    scattering: b / OPTICS.referenceScattering,
    visibility: 3.9 / (ext[1] + w.nearBottomTurbidity),
    waveHeight: c ? c.sea.waveHeight : 0.6,
    wavePeriod: c ? c.sea.wavePeriod : 6,
  };
}

/** Puffs of the resuspended cloud drawn by the composite of each camera (nearest/most relevant). */
export const MAX_SILT_PUFFS = 6;
/** Vehicle lamps known to the composite (lamp-path attenuation + lighting of the cloud). */
export const MAX_WATER_LAMPS = 4;

/** World-space state of the vehicle lamps for the current frame. */
export interface WaterLamps {
  count: number;
  pos: Vector3[];
  dir: Vector3[];
  cosOuter: number[];
  cosInner: number[];
  /** Luminous intensity as used by the scene (SpotLight.intensity, 0 when off). */
  intensity: number[];
}

/**
 * Frame-global state of the water that every camera panel applies to its
 * own composite (`UnderwaterPass.setSiltField`): the resuspended sediment
 * cloud, the tint of its particles and the vehicle lamps. Owned by World,
 * updated once per frame, read by every pass in every window.
 */
export interface SiltField {
  cloud: SedimentCloud | null;
  /** Puffs per camera in the composite (water detail, ≤ MAX_SILT_PUFFS). */
  maxPuffs: number;
  /** Single-scattering albedo (linear RGB) of the suspended particles. */
  albedo: Color;
  lamps: WaterLamps;
}

export function createSiltField(cloud: SedimentCloud | null = null): SiltField {
  return {
    cloud,
    maxPuffs: MAX_SILT_PUFFS,
    albedo: new Color(0.5, 0.48, 0.4),
    lamps: {
      count: 0,
      pos: Array.from({ length: MAX_WATER_LAMPS }, () => new Vector3()),
      dir: Array.from({ length: MAX_WATER_LAMPS }, () => new Vector3(1, 0, 0)),
      cosOuter: new Array(MAX_WATER_LAMPS).fill(0.85),
      cosInner: new Array(MAX_WATER_LAMPS).fill(0.95),
      intensity: new Array(MAX_WATER_LAMPS).fill(0),
    },
  };
}
