import { describe, expect, it } from 'vitest';
import { launchGuide, type GuideInput } from '../src/mission/launchGuide';

const base: GuideInput = {
  lars: 'deck',
  launchAuthorised: false,
  checks: { lights: false, thrusters: false, camera: false },
  stationArranged: false,
  tmsDepth: 0,
  tmsTargetDepth: 50,
  payout: 3,
  chord: 0.5,
};

describe('operational launch guide (non-blocking)', () => {
  it('on deck: current step is the launch preparation; optional checks never hold it', () => {
    const g = launchGuide(base);
    expect(g.steps.map((s) => s.id)).toEqual(['prep', 'station', 'instruments', 'launchPrep', 'descent', 'position', 'release', 'operation']);
    expect(g.steps[g.current].id).toBe('launchPrep');
    expect(g.complete).toBe(false);
  });

  it('follows the real state: lowering → depth progress; latched at depth → release; released and away → complete', () => {
    const low = launchGuide({ ...base, launchAuthorised: true, lars: 'lowering', tmsDepth: 34 });
    expect(low.steps[low.current].id).toBe('descent');
    expect(low.steps.find((s) => s.id === 'descent')!.detail).toEqual({ key: 'guide.d.descent', params: { d: 34, t: 50 } });
    // Skipped optional checks are shown as done-by-progress, never blocking.
    expect(low.steps.find((s) => s.id === 'instruments')!.done).toBe(true);
    const at = launchGuide({ ...base, lars: 'atDepth', tmsDepth: 50 });
    expect(at.steps[at.current].id).toBe('release');
    const rel = launchGuide({ ...base, lars: 'released', payout: 4, chord: 2 });
    expect(rel.steps[rel.current].id).toBe('operation');
    const away = launchGuide({ ...base, lars: 'released', payout: 12, chord: 9 });
    expect(away.complete).toBe(true);
    expect(away.current).toBe(-1);
  });

  it('subsea starts (free / TMS missions) begin at the release step', () => {
    const g = launchGuide({ ...base, lars: 'atDepth', launchAuthorised: true, tmsDepth: 50 });
    expect(g.steps.slice(0, 6).every((s) => s.done)).toBe(true);
    expect(g.steps[g.current].id).toBe('release');
  });
});
