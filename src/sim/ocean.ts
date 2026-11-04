/**
 * Ocean current model (simplified).
 *
 * A depth-dependent profile — stronger near the surface, weaker at depth,
 * with a logarithmic-like decay in the bottom boundary layer — whose
 * direction veers slowly with depth, modulated by slow deterministic
 * fluctuations. Values are illustrative of a moderate offshore site, not of
 * any specific field.
 */

export type CurrentLevel = 'off' | 'low' | 'normal' | 'strong';

const LEVEL_SCALE: Record<CurrentLevel, number> = { off: 0, low: 0.5, normal: 1, strong: 1.8 };

export interface CurrentSample {
  /** World velocity of the water (m/s), +Y up. */
  x: number;
  y: number;
  z: number;
}

/**
 * @param depth metres below surface (positive)
 * @param altitude metres above seabed (may be large)
 * @param t simulation time (s)
 */
export function currentAt(depth: number, altitude: number, t: number, level: CurrentLevel): CurrentSample {
  const k = LEVEL_SCALE[level];
  if (k === 0 || depth < 0) return { x: 0, y: 0, z: 0 };
  const surface = 0.32;
  const deep = 0.14;
  let speed = deep + (surface - deep) * Math.exp(-depth / 40);
  // Bottom boundary layer.
  if (altitude < 8) speed *= 0.55 + 0.45 * Math.max(0, altitude) / 8;
  // Slow fluctuations (periods of ~40–90 s).
  speed *= 1 + 0.18 * Math.sin(t * 0.071 + depth * 0.05) + 0.08 * Math.sin(t * 0.157 + 1.3);
  // Direction: towards ~070° at the surface veering to ~110° at depth.
  const headingDeg = 70 + 40 * (1 - Math.exp(-depth / 60)) + 6 * Math.sin(t * 0.05);
  const h = (headingDeg * Math.PI) / 180;
  // heading 0 = north (-Z), 90 = east (+X)
  return { x: Math.sin(h) * speed * k, y: 0, z: -Math.cos(h) * speed * k };
}
