import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Simulation } from '../src/sim/simulation';
import { missionById } from '../src/mission/catalog';
import { TOPHAT } from '../src/sim/topHat';

const upd = (sim: Simulation) =>
  sim.updateMission(0.25, { cameraPosition: { x: 0, y: 0, z: 0 }, cameraDirection: { x: 1, y: 0, z: 0 }, cameraMode: 'operational' });

/** Free ROV, cleared from the TMS, then placed just under the receptacle. */
function approachDock(sim: Simulation, opts: { headingOffsetDeg?: number; speed?: number; payout?: number } = {}) {
  sim.releaseRov();
  sim.rov.position.y -= 4; // clear the TMS → capture armed
  for (let i = 0; i < 4; i++) sim.advance(0.05);
  const dock = sim.lars.dockPosition(new Vector3());
  sim.rov.position.copy(dock).add(new Vector3(0.1, -0.25, 0.05));
  const yaw = sim.lars.yaw - ((opts.headingOffsetDeg ?? 0) * Math.PI) / 180;
  sim.rov.orientation.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  sim.rov.velocity.set(0, opts.speed ?? 0.05, 0);
  sim.rov.angularVelocity.set(0, 0, 0);
  sim.tms.reset(opts.payout ?? 6, 'manual');
}

describe('Top-Hat launch & recovery', () => {
  it('A: ROV and Top-Hat go down together; the ROV cannot move while latched', () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.tmsDepth = 50;
    sim.reset('stabilize', missionById('inspection'));
    expect(sim.lars.state).toBe('deck');
    sim.lars.startLowering();
    sim.command.surge = 1; // pilot tries to fly away
    for (let i = 0; i < 4 * 30; i++) sim.advance(0.25);
    const d = sim.rov.position.clone().sub(sim.lars.position);
    expect(Math.hypot(d.x, d.z)).toBeLessThan(0.05);
    expect(d.y).toBeCloseTo(-TOPHAT.dockDrop, 1);
    expect(sim.lars.state).toBe('lowering');
  });

  it('B: release only at the operating depth (configurable), then the tether takes over', () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.tmsDepth = 45;
    sim.reset('stabilize', missionById('inspection'));
    expect(sim.releaseRov()).toBe(false); // on deck: not allowed
    sim.lars.startLowering();
    for (let i = 0; i < 4 * 80 && sim.lars.state !== 'atDepth'; i++) sim.advance(0.25);
    expect(sim.lars.position.y).toBeCloseTo(-45, 2);
    expect(sim.releaseRov()).toBe(true);
    expect(sim.tether.enabled).toBe(true);
    sim.command.surge = 0.6;
    for (let i = 0; i < 4 * 20; i++) sim.advance(0.25);
    expect(sim.rov.position.distanceTo(sim.lars.dockPosition(new Vector3()))).toBeGreaterThan(3);
    expect(sim.tms.payout).toBeGreaterThan(4); // AUTO pays out as the ROV leaves
  });

  it('J: docking requires alignment, low speed and tether hauled in; then the assembly rises to deck', () => {
    for (const bad of [{ headingOffsetDeg: 40 }, { speed: 0.9 }, { payout: 30 }]) {
      const sim = new Simulation('stabilize', 'tms');
      approachDock(sim, bad);
      sim.advance(1 / 120);
      expect(sim.lars.state).toBe('released');
    }
    const sim = new Simulation('stabilize', 'tms');
    approachDock(sim);
    sim.advance(1 / 60);
    expect(sim.lars.state).toBe('atDepth');
    expect(sim.tether.enabled).toBe(false);
    // Latched: smoothly pulled into the dock pose (no teleport).
    const before = sim.rov.position.distanceTo(sim.lars.dockPosition(new Vector3()));
    sim.advance(0.25);
    const after = sim.rov.position.distanceTo(sim.lars.dockPosition(new Vector3()));
    expect(after).toBeLessThan(before);
    expect(sim.raiseAssembly()).toBe(true);
    for (let i = 0; i < 4 * 200 && sim.lars.state !== 'onDeck'; i++) sim.advance(0.25);
    expect(sim.lars.state).toBe('onDeck');
    expect(sim.rov.position.y).toBeGreaterThan(0);
  });

  it('strict mode (no assist) needs tighter alignment than assisted mode', () => {
    const a = new Simulation('stabilize', 'tms');
    a.lars.assist = true;
    approachDock(a, { headingOffsetDeg: 15 });
    a.advance(1 / 60);
    const b = new Simulation('stabilize', 'tms');
    b.lars.assist = false;
    approachDock(b, { headingOffsetDeg: 15 });
    b.advance(1 / 60);
    expect(a.lars.state).toBe('atDepth');
    expect(b.lars.state).toBe('released');
  });

  it('inspection: docking in the return stage triggers the recovery ascent', () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.reset('stabilize', missionById('inspection'));
    sim.lars.reset('atDepth', 80);
    const m = sim.mission as unknown as { stage: string };
    m.stage = 'return';
    approachDock(sim);
    sim.advance(1 / 60);
    upd(sim);
    expect(m.stage).toBe('recovery');
    sim.advance(0.1);
    expect(sim.lars.state).toBe('raising');
  });
});

describe('pitch & tether torque', () => {
  const free = () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.crane = 'released';
    sim.tms.reset(300, 'manual');
    sim.rov.position.set(0, -60, -40);
    return sim;
  };

  it('H: vertical thrusters give real pitch authority; release returns to level', () => {
    const sim = free();
    sim.command.pitch = 1;
    for (let i = 0; i < 4 * 15; i++) sim.advance(0.25);
    expect(sim.rov.pitch).toBeGreaterThan(9);
    expect(sim.rov.pitch).toBeLessThan(20);
    sim.command.pitch = -1;
    for (let i = 0; i < 4 * 15; i++) sim.advance(0.25);
    expect(sim.rov.pitch).toBeLessThan(-9);
    sim.command.pitch = 0;
    for (let i = 0; i < 4 * 15; i++) sim.advance(0.25);
    expect(Math.abs(sim.rov.pitch)).toBeLessThan(2);
  });

  it('tether force acts at the aft-top termination (torque), not at the CG', () => {
    expect(new Simulation().rov.tetherAttach.x).toBeLessThan(-0.3);
    const pitchWith = (payout: number) => {
      const sim = free();
      sim.setMode('manual');
      sim.tms.reset(payout, 'manual');
      sim.tether.reset(sim.tmsExit, sim.attachWorld());
      sim.command.surge = 0.8;
      for (let i = 0; i < 4 * 25; i++) sim.advance(0.25);
      return { pitch: sim.rov.pitch, tension: sim.tether.tension };
    };
    const slack = pitchWith(300);
    const taut = pitchWith(new Simulation().tmsExit.distanceTo(new Vector3(0, -60, -40)) + 2);
    expect(taut.tension).toBeGreaterThan(300);
    expect(Math.abs(taut.pitch - slack.pitch)).toBeGreaterThan(1);
  });
});
