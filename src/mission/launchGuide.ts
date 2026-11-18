/**
 * Operational launch guide (replaces the blocking pre-dive checklist).
 *
 * A pure function of the REAL simulation state: each step is shown as done
 * when the state says so; nothing waits for the operator to tick boxes and no
 * step blocks the next one. The operator may follow it, skip it or hide it.
 */
import type { LarsState } from '../sim/topHat';

export type GuideStepId = 'prep' | 'station' | 'instruments' | 'launchPrep' | 'descent' | 'position' | 'release' | 'operation';
export const GUIDE_STEPS: GuideStepId[] = ['prep', 'station', 'instruments', 'launchPrep', 'descent', 'position', 'release', 'operation'];

export interface GuideInput {
  /** Top-Hat / launch state. */
  lars: LarsState;
  /** Launch has been authorised (crane missions) or the operation started subsea. */
  launchAuthorised: boolean;
  /** Visual checks observed in the simulation (lights used, thrusters commanded, cameras switched). */
  checks: { lights: boolean; thrusters: boolean; camera: boolean };
  /** Station arranged: a multi-panel layout or at least one monitor window open. */
  stationArranged: boolean;
  /** Current Top-Hat depth and its operating (target) depth (m, positive). */
  tmsDepth: number;
  tmsTargetDepth: number;
  /** Tether paid out (m) and straight distance ROV → Top-Hat exit (m). */
  payout: number;
  chord: number;
}

export interface GuideStep {
  id: GuideStepId;
  done: boolean;
  /** Optional steps never hold the "current" marker. */
  optional: boolean;
  /** Short live detail (e.g., "descendo: 34 / 50 m"), already formatted values; key + params for i18n. */
  detail?: { key: string; params?: Record<string, string | number> };
}

export interface GuideView {
  steps: GuideStep[];
  /** Index of the first required step not done (-1 when the launch is complete). */
  current: number;
  complete: boolean;
}

export function launchGuide(s: GuideInput): GuideView {
  const latched = s.lars === 'atDepth';
  const released = s.lars === 'released';
  const afterLaunch = s.launchAuthorised || s.lars !== 'deck';
  const reachedDepth = latched || released || s.lars === 'raising' || s.lars === 'onDeck';
  const checksDone = s.checks.lights && s.checks.thrusters && s.checks.camera;
  const nChecks = Number(s.checks.lights) + Number(s.checks.thrusters) + Number(s.checks.camera);
  const steps: GuideStep[] = [
    { id: 'prep', done: true, optional: false },
    { id: 'station', done: s.stationArranged || afterLaunch, optional: true },
    { id: 'instruments', done: checksDone || afterLaunch, optional: true, detail: { key: 'guide.d.checks', params: { n: nChecks } } },
    { id: 'launchPrep', done: afterLaunch, optional: false },
    {
      id: 'descent',
      done: reachedDepth,
      optional: false,
      detail: s.lars === 'lowering' ? { key: 'guide.d.descent', params: { d: Math.round(s.tmsDepth), t: Math.round(s.tmsTargetDepth) } } : undefined,
    },
    { id: 'position', done: reachedDepth, optional: false },
    { id: 'release', done: released, optional: false },
    {
      id: 'operation',
      done: released && (s.payout > 8 || s.chord > 6),
      optional: false,
      detail: released ? { key: 'guide.d.payout', params: { p: s.payout.toFixed(0) } } : undefined,
    },
  ];
  const current = steps.findIndex((x) => !x.done && !x.optional);
  return { steps, current, complete: current === -1 };
}
