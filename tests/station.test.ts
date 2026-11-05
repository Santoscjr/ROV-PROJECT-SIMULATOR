import { describe, expect, it } from 'vitest';
import { layoutRects, glViewport } from '../src/render/station';
import { CameraRig, CAMERA_MODES } from '../src/render/cameras';
import { Simulation } from '../src/sim/simulation';
import { missionById } from '../src/mission/catalog';
import type { TaskMission } from '../src/mission/taskMission';
import { sanitizeSettings } from '../src/config/settings';

describe('station layouts', () => {
  it('single, dual and quad tile the screen without overlap', () => {
    for (const [l, n] of [
      ['single', 1],
      ['dual', 2],
      ['quad', 4],
    ] as const) {
      const r = layoutRects(l, 1000, 600);
      expect(r).toHaveLength(n);
      expect(r.reduce((a, x) => a + x.w * x.h, 0)).toBe(1000 * 600);
    }
    const vp = glViewport({ x: 0, y: 0, w: 500, h: 300 }, 600, 2);
    expect(vp).toEqual({ x: 0, y: 600, w: 1000, h: 600 });
  });

  it('layout and panel sources persist through settings sanitising', () => {
    const s = sanitizeSettings({ layout: 'quad', panels: ['operational', 'tms', 'nope', 'sonar'] });
    expect(s.layout).toBe('quad');
    expect(s.panels).toEqual(['operational', 'tms', 'tms', 'sonar']);
  });

  it('camera rig cycles through all sources', () => {
    const rig = new CameraRig(1);
    rig.setMode('operational');
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add(rig.cycle());
    expect([...seen].sort()).toEqual([...CAMERA_MODES].sort());
  });
});

describe('TMS training mission', () => {
  it('requires MANUAL, real payout and real distance (not button presses)', () => {
    const sim = new Simulation('stabilize', 'tms');
    sim.reset('stabilize', missionById('tms'));
    const m = sim.mission as TaskMission;
    const upd = () => sim.updateMission(0.25, { cameraPosition: { x: 0, y: 0, z: 0 }, cameraDirection: { x: 1, y: 0, z: 0 }, cameraMode: 'operational' });
    upd();
    expect(m.index).toBe(0);
    sim.tms.reset(sim.tms.payout, 'manual');
    upd();
    upd();
    expect(m.index).toBe(1);
    // Pay out by running the winch.
    sim.tms.setCommand(true, false);
    for (let i = 0; i < 4 * 40 && m.index === 1; i++) {
      sim.advance(0.25);
      upd();
    }
    expect(sim.tms.payout).toBeGreaterThanOrEqual(25);
    expect(m.index).toBe(2);
    sim.tms.setCommand(false, false);
    // Moving away is only complete with real distance.
    upd();
    expect(m.index).toBe(2);
  });
});
