import { Color } from 'three';

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
  /** Beam extinction for imaging (1/m) for R, G, B. */
  extinction: [0.36, 0.1, 0.08] as const,
  /** Additional extinction near the seabed from suspended sediment (1/m). */
  turbidityNearBottom: 0.035,
  /** Colour of light scattered by the water column at the surface. */
  scatterColor: new Color(0.07, 0.36, 0.42),
};

/** Fraction of surface sunlight per channel reaching `depth` metres. */
export function sunTransmission(depth: number, out = new Color()): Color {
  const d = Math.max(0, depth);
  return out.setRGB(Math.exp(-OPTICS.kd[0] * d), Math.exp(-OPTICS.kd[1] * d), Math.exp(-OPTICS.kd[2] * d));
}
