import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { SegmentTether } from '../src/physics/segmentTether';
import { TmsWinch } from '../src/sim/tms';
import { Simulation } from '../src/sim/simulation';
import { missionById } from '../src/mission/catalog';

const still = (_p: Vector3, out: Vector3) => out.set(0, 0, 0);
const DT = 1 / 120;

function chain(payout: number, current = still, floor = -1000) {
  const t = new SegmentTether(current, {}, () => floor);
  t.payout = payout;
  t.reset(new Vector3(0, -50, 0), new Vector3(0, -50, -10));
  return t;
}
function run(t: SegmentTether, attach: Vector3, seconds: number) {
  const f = new Vector3();
  for (let i = 0; i < seconds / DT; i++) t.step(DT, attach, new Vector3(), f);
  return f;
}
const finite = (t: SegmentTether) => t.p.every((p) => Number.isFinite(p.x + p.y + p.z));

describe('TMS winch', () => {
  it('pays out and hauls in continuously with ramped speed, within limits', () => {
    const w = new TmsWinch({}, 20);
    w.reset(20, 'manual');
    w.setCommand(true, false);
    for (let i = 0; i < 120; i++) w.update(DT, 10, 0);
    expect(w.payout).toBeGreaterThan(20.2);
    expect(w.payout).toBeLessThan(20.8); // ramped, not instantaneous
    for (let i = 0; i < 1200; i++) w.update(DT, 10, 0);
    expect(w.speed).toBeCloseTo(w.config.payRate, 2);
    const angle = w.drumAngle;
    w.setCommand(false, true);
    for (let i = 0; i < 1200; i++) w.update(DT, 10, 0);
    expect(w.speed).toBeLessThan(0);
    expect(w.drumAngle).toBeLessThan(angle); // drum turns the other way
    w.setCommand(false, false);
    for (let i = 0; i < 600; i++) w.update(DT, 10, 0);
    expect(w.speed).toBe(0);
  });

  it('never exceeds max length nor goes below min length', () => {
    const w = new TmsWinch({ maxLength: 50 }, 49);
    w.reset(49, 'manual');
    w.setCommand(true, false);
    for (let i = 0; i < 2400; i++) w.update(DT, 10, 0);
    expect(w.payout).toBe(50);
    expect(w.state).toBe('limitMax');
    w.setCommand(false, true);
    for (let i = 0; i < 120 * 200; i++) w.update(DT, 2, 0);
    expect(w.payout).toBe(w.config.minLength);
    expect(w.state).toBe('limitMin');
  });

  it('inhibits hauling above the tension limit and slips under overload', () => {
    const w = new TmsWinch({}, 40);
    w.reset(40, 'manual');
    w.setCommand(false, true);
    for (let i = 0; i < 240; i++) w.update(DT, 40, 5000);
    expect(w.state).toBe('tensionTrip');
    expect(w.payout).toBeGreaterThanOrEqual(39.9);
    for (let i = 0; i < 240; i++) w.update(DT, 40, 12000);
    expect(w.state).toBe('slip');
    expect(w.payout).toBeGreaterThan(40);
  });

  it('simultaneous pay + haul resolves to stop', () => {
    const w = new TmsWinch();
    w.setCommand(true, true);
    expect(w.command).toBe('stop');
  });

  it('AUTO keeps a working slack relative to the distance', () => {
    const w = new TmsWinch({}, 10);
    w.reset(10, 'auto');
    for (let i = 0; i < 120 * 120; i++) w.update(DT, 40, 0);
    expect(w.payout).toBeGreaterThan(45);
    expect(w.payout).toBeLessThan(60);
  });
});

describe('segment tether (PBD)', () => {
  it('slack cable: no significant pull, forms a curve', () => {
    const t = chain(30);
    const f = run(t, new Vector3(0, -50, -10), 20);
    expect(f.length()).toBeLessThan(60);
    // Mid-cable hangs below the straight line (neutral-ish but slightly heavy).
    expect(t.p[16].y).toBeLessThan(-50.2);
    expect(t.slack).toBeGreaterThan(15);
    expect(finite(t)).toBe(true);
  });

  it('taut cable: tension rises progressively and pulls the ROV back toward the TMS', () => {
    const t = chain(20);
    const f1 = run(t, new Vector3(0, -50, -20.2), 3);
    const f2 = run(t, new Vector3(0, -50, -20.6), 3);
    expect(f2.length()).toBeGreaterThan(f1.length());
    expect(f2.z).toBeGreaterThan(0); // toward the anchor (+Z)
    expect(t.tension).toBeLessThan(t.config.maxForce + 1);
  });

  it('current drags the slack cable down-stream', () => {
    const t = chain(40, (_p, out) => out.set(0.6, 0, 0));
    run(t, new Vector3(0, -50, -10), 30);
    expect(t.p[16].x).toBeGreaterThan(1);
  });

  it('cable rests on the seabed without sinking through', () => {
    const t = chain(60, still, -55);
    run(t, new Vector3(0, -52, -10), 30);
    for (const p of t.p) expect(p.y).toBeGreaterThan(-55 + 0.04);
    expect(t.contacts.seabed).toBeGreaterThan(0);
  });

  it('cable does not pass through the ROV body', () => {
    // Anchor above the vehicle, attach at the bow, slack cable falling onto the top.
    const t = new SegmentTether(still, { wetWeight: 3 }, () => -1000);
    t.payout = 12;
    const rovPos = new Vector3(0, -60, 0);
    t.setVehicle(rovPos, new Quaternion());
    t.reset(new Vector3(-0.5, -57, 0), new Vector3(1.2, -59.5, 0));
    run(t, new Vector3(1.2, -59.5, 0), 10);
    for (let i = 1; i < t.n - 2; i++) {
      const q = t.p[i].clone().sub(rovPos);
      const inside = Math.abs(q.x) < 1.3 && Math.abs(q.y + 0.05) < 0.8 && Math.abs(q.z) < 0.8;
      expect(inside).toBe(false);
    }
  });

  it('extreme cases stay finite: sudden jump, fully paid-out, almost fully hauled', () => {
    const t = chain(300);
    run(t, new Vector3(0, -50, -10), 5);
    run(t, new Vector3(150, -40, -200), 5); // teleport → re-lay
    expect(finite(t)).toBe(true);
    t.payout = 3;
    const f = run(t, new Vector3(0, -50, -30), 5); // far beyond payout
    expect(finite(t)).toBe(true);
    expect(f.length()).toBeLessThanOrEqual(t.config.maxForce + 5);
  });
});

describe('TMS in the simulation', () => {
  it('the ROV cannot fly away beyond the paid-out tether', () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.crane = 'released';
    sim.rov.kinematic = false;
    sim.tms.reset(25, 'manual');
    sim.rov.position.set(sim.tmsExit.x, sim.tmsExit.y - 10, sim.tmsExit.z);
    sim.tether.payout = 25;
    sim.tether.reset(sim.tmsExit, sim.rov.position);
    sim.command.surge = 1;
    for (let i = 0; i < 4 * 60; i++) sim.advance(0.25);
    const d = sim.rov.position.distanceTo(sim.tmsExit);
    expect(d).toBeLessThan(27.5);
    expect(sim.tether.tension).toBeGreaterThan(200);
    expect(Number.isFinite(sim.rov.position.x)).toBe(true);
  });

  it('paying out lets the ROV go further (length changes the physics)', () => {
    const go = (payout: number) => {
      const sim = new Simulation('stabilize', 'inspection');
      sim.crane = 'released';
      sim.rov.kinematic = false;
      sim.tms.reset(payout, 'manual');
      sim.rov.position.set(sim.tmsExit.x, sim.tmsExit.y - 10, sim.tmsExit.z);
      sim.tether.payout = payout;
      sim.tether.reset(sim.tmsExit, sim.rov.position);
      sim.command.surge = 1;
      for (let i = 0; i < 4 * 60; i++) sim.advance(0.25);
      return sim.rov.position.distanceTo(sim.tmsExit);
    };
    expect(go(60)).toBeGreaterThan(go(25) + 15);
  });

  it('restart resets the TMS and tether to a valid state; strong current stays stable', () => {
    const sim = new Simulation('stabilize', 'adverse');
    for (let i = 0; i < 4 * 30; i++) sim.advance(0.25);
    sim.reset('stabilize', missionById('adverse'));
    expect(sim.tms.payout).toBeGreaterThan(sim.tmsExit.distanceTo(sim.rov.position));
    for (let i = 0; i < 4 * 30; i++) sim.advance(0.25);
    expect(sim.tether.p.every((p) => Number.isFinite(p.x))).toBe(true);
  });
});
