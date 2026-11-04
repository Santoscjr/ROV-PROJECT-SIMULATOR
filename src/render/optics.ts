import { Color } from 'three';
import type { EnvironmentConditions } from '../sim/conditions';

/**
 * Simplified spectral optics of sea water (three channels).
 *
 * Diffuse attenuation Kd governs how sunlight fades with depth; beam
 * extinction c governs how a scene fades with viewing distance. Values are
 * of the order of clear oceanic / offshore shelf water (Jerlov type I–II) —
 * red is absorbed within a few metres, blue penetrates furthest. They are
 * tuned for appearance, not measured for a specific site.
 */
export const OPTICS = {
  /** Diffuse attenuation of downwelling sunlight (1/m) for R, G, B. */
  kd: [0.36, 0.058, 0.036] as const,
  /** Beam extinction for imaging (1/m) for R, G, B (includes the reference turbidity). */
  extinction: [0.36, 0.1, 0.08] as const,
  /** Additional extinction near the seabed from suspended sediment (1/m). */
  turbidityNearBottom: 0.035,
  /** Colour of light scattered by the water column at the surface. */
  scatterColor: new Color(0.07, 0.36, 0.42),
  /**
   * Turbidity already contained in `extinction` (the "normal" visibility of
   * `EnvironmentConditions`). Conditions add `turbidity − REFERENCE` on top.
   */
  referenceTurbidity: 0.035,
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
 * numbers so the image stays physically consistent.
 */
export interface WaterOptics {
  /** Beam extinction c (1/m) per channel, including turbidity. */
  ext: [number, number, number];
  /** Diffuse attenuation Kd (1/m) per channel, including turbidity. */
  kd: [number, number, number];
  /** Extra Kd over the clear-water reference (1/m) — for sunTransmission. */
  extraKd: number;
  /** Turbidity relative to the reference (1/m, may be slightly negative). */
  extraTurbidity: number;
  /** In-scattered radiance at the surface (already scaled by irradiance). */
  scatter: Color;
  /** Extra extinction near the seabed (1/m). */
  nearBottom: number;
  /** Surface irradiance multiplier (1 = clear day). */
  irradiance: number;
  /** 0 = direct sun, 1 = fully diffuse sky (overcast / night). */
  overcast: number;
  /** Multiplier on suspended particle count. */
  particleDensity: number;
  /** Relative scattering coefficient (1 = reference water): beam backscatter. */
  scattering: number;
  waveHeight: number;
  wavePeriod: number;
}

const SEDIMENT_SCATTER = new Color(0.17, 0.36, 0.34);

export function waterOptics(c: EnvironmentConditions | null): WaterOptics {
  const turb = c ? c.water.turbidity : OPTICS.referenceTurbidity;
  const extra = turb - OPTICS.referenceTurbidity;
  const ext = OPTICS.extinction.map((e) => Math.max(e * 0.55, e + extra)) as [number, number, number];
  // Particles scatter mostly forward: diffuse attenuation grows less than beam extinction.
  const extraKd = Math.max(-0.01, extra * 0.45);
  const kd = OPTICS.kd.map((k) => Math.max(k * 0.7, k + extraKd)) as [number, number, number];
  const irradiance = c ? c.light.surfaceIrradiance : 1;
  // Sediment brightens the veil (b/c rises) and shifts it towards grey-green.
  const scatter = OPTICS.scatterColor
    .clone()
    .lerp(SEDIMENT_SCATTER, Math.min(0.55, Math.max(0, extra) * 3))
    .multiplyScalar((1 + 2.2 * extra) * irradiance);
  return {
    ext,
    kd,
    extraKd,
    extraTurbidity: extra,
    scatter,
    nearBottom: c ? c.water.nearBottomTurbidity : OPTICS.turbidityNearBottom,
    irradiance,
    overcast: Math.min(1, Math.max(0, (1 - irradiance) / 0.65)),
    particleDensity: c ? c.water.particleDensity : 1,
    scattering: Math.max(0.4, (0.06 + turb) / (0.06 + OPTICS.referenceTurbidity)),
    waveHeight: c ? c.sea.waveHeight : 0.6,
    wavePeriod: c ? c.sea.wavePeriod : 6,
  };
}
