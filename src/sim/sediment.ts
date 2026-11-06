/**
 * Seabed sediment field — SHARED CONTRACT between the terrain/seabed renderer
 * (colour, roughness) and the resuspension model (erodibility, settling).
 * Deterministic for a given seed; never depends on graphics quality.
 *
 * Signature is fixed (other modules import it); internals may evolve.
 */
import { fbm } from './terrain';

export interface SedimentMix {
  /** Weights in [0,1] summing to 1. */
  mud: number;
  sand: number;
  gravel: number;
}

/** Resuspension properties derived from a mix (approximate, documented in docs/research). */
export interface SedimentProps {
  /** Relative ease of being lifted by a jet (mud 1, sand ~0.45, gravel ~0.05). */
  erodibility: number;
  /** Settling time scale of the cloud (s): fine mud stays in suspension much longer. */
  settleTime: number;
}

/** Sediment mix at a seabed point (world x/z, metres). */
export function sedimentAt(x: number, z: number, seed = 0): SedimentMix {
  const o = seed * 0.0137;
  // Large-scale patches of mud vs sand, with gravel near rocky areas.
  const n1 = fbm(x / 60 + o, z / 60 - o, 3); // [-1,1]
  const n2 = fbm(x / 18 - o, z / 18 + o, 2);
  let sand = Math.min(1, Math.max(0, 0.35 + 0.55 * n1 + 0.15 * n2));
  let gravel = Math.min(1, Math.max(0, (fbm(x / 25 + 3.1 + o, z / 25 - 7.7, 2) - 0.25) * 1.6)) * 0.6;
  let mud = Math.max(0, 1 - sand - gravel);
  const s = mud + sand + gravel || 1;
  mud /= s;
  sand /= s;
  gravel /= s;
  return { mud, sand, gravel };
}

export function sedimentProps(m: SedimentMix): SedimentProps {
  return {
    erodibility: m.mud * 1 + m.sand * 0.45 + m.gravel * 0.05,
    settleTime: m.mud * 40 + m.sand * 8 + m.gravel * 2,
  };
}
