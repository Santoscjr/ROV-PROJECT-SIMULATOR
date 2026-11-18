import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { RovController, type PilotMode } from '../src/control/rovController';
import { Simulation } from '../src/sim/simulation';
import { zeroAxes, type AxisCommand } from '../src/input/types';

/**
 * ROV dynamics metrics requested by the product owner (v3.2) that were not
 * already covered by physics.test.ts / controller.test.ts: stop behaviour in
 * STABILIZE, yaw stop time, drift in MANUAL with the controller in the loop,
 * loss of command, depth hold with the full simulation (segment tether + site current).
 */

const DT = 1 / 120;

const env = (current = new Vector3()): PhysicsEnvironment => ({
  current: (_p, out) => out.copy(current),
  terrainHeight: () => -500,
  colliders: [],
});

function setup(mode: PilotMode, depth = 60) {
  const rov = new RovPhysics();
  rov.reset(new Vector3(0, -depth, 0), 0);
  const ctrl = new RovController(rov);
  ctrl.mode = mode;
  ctrl.reset();
  return { rov, ctrl };
}

function run(rov: RovPhysics, ctrl: RovController, seconds: number, cmd: Partial<AxisCommand>, e: PhysicsEnvironment, each?: (t: number) => void) {
  const axes = { ...zeroAxes(), ...cmd };
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    ctrl.update(axes, DT);
    rov.step(DT, e);
    each?.((i + 1) * DT);
  }
}

describe('surge start / stop (STABILIZE)', () => {
  it('accelerates progressively to a steady speed, then decelerates monotonically to < 0.05 m/s with no reversal', () => {
    const { rov, ctrl } = setup('stabilize');
    const e = env();
    const v: number[] = [];
    run(rov, ctrl, 30, { surge: 1 }, e, (t) => {
      if (Math.abs(t - Math.round(t * 2) / 2) < 1e-9) v.push(rov.velocity.x); // every 0.5 s
    });
    const top = rov.velocity.x;
    expect(top).toBeGreaterThan(1.2);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1] - 1e-6); // never slows while commanded
    expect(v[0]).toBeLessThan(0.15 * top); // no instant velocity (0.5 s)
    expect(v[3]).toBeLessThan(0.75 * top); // still accelerating at 2 s
    expect(v[29]).toBeGreaterThan(0.97 * top); // steady by 15 s
    expect(Math.abs(v[v.length - 1] - v[v.length - 3])).toBeLessThan(0.01); // steady speed

    let prev = rov.velocity.x;
    let increase = 0;
    let minV = Infinity;
    let tStop = -1;
    run(rov, ctrl, 40, {}, e, (t) => {
      const vx = rov.velocity.x;
      increase = Math.max(increase, vx - prev);
      minV = Math.min(minV, vx);
      prev = vx;
      if (tStop < 0 && Math.abs(vx) < 0.05) tStop = t;
    });
    expect(increase).toBeLessThan(1e-6); // monotonic deceleration
    expect(minV).toBeGreaterThan(-0.01); // no overshoot reversal
    expect(tStop).toBeGreaterThan(5); // glides (no artificial brake)
    expect(tStop).toBeLessThan(30);
    expect(Math.hypot(rov.velocity.x, rov.velocity.z)).toBeLessThan(0.05);
  });

  it('stops a yaw turn within 3 s of releasing the stick, rate settles to ~0', () => {
    const { rov, ctrl } = setup('stabilize');
    const e = env();
    run(rov, ctrl, 6, { yaw: 1 }, e);
    expect(rov.yawRate).toBeGreaterThan(30);
    let tStop = -1;
    run(rov, ctrl, 10, {}, e, (t) => {
      if (tStop < 0 && Math.abs(rov.yawRate) < 0.5) tStop = t;
    });
    expect(tStop).toBeGreaterThan(0);
    expect(tStop).toBeLessThan(3);
    expect(Math.abs(rov.yawRate)).toBeLessThan(0.05);
  });
});

describe('current and loss of command', () => {
  it('MANUAL with no input drifts with a lateral current (controller in the loop does not hold position)', () => {
    const { rov, ctrl } = setup('manual');
    const p0 = rov.position.clone();
    run(rov, ctrl, 60, {}, env(new Vector3(0, 0, 0.3)));
    const drift = rov.position.clone().sub(p0);
    expect(drift.z).toBeGreaterThan(10);
    expect(rov.worldVelocity().z).toBeGreaterThan(0.25); // ~ the current speed
    expect(Math.abs(drift.x)).toBeLessThan(1);
  });

  for (const mode of ['manual', 'stabilize', 'depthHold'] as PilotMode[]) {
    it(`loss of command (all axes zero) after a combined manoeuvre → safe stop in ${mode.toUpperCase()}`, () => {
      const { rov, ctrl } = setup(mode);
      const e = env();
      run(rov, ctrl, 8, { surge: 0.8, sway: -0.6, heave: 0.5, yaw: 0.7 }, e);
      const d0 = rov.depth;
      run(rov, ctrl, 30, {}, e);
      const vw = rov.worldVelocity();
      expect(Math.hypot(vw.x, vw.z)).toBeLessThan(0.05); // horizontal motion stopped
      expect((rov.angularVelocity.length() * 180) / Math.PI).toBeLessThan(0.5); // rotation stopped
      expect(Math.abs(rov.pitch)).toBeLessThan(1);
      expect(Math.abs(rov.roll)).toBeLessThan(1);
      // Never dives on its own: either holds depth or floats up slowly (positive buoyancy = fail-safe).
      expect(vw.y).toBeGreaterThan(-0.02);
      expect(vw.y).toBeLessThan(0.3);
      if (mode === 'depthHold') expect(Math.abs(rov.depth - d0)).toBeLessThan(1);
      if (mode === 'manual') expect(Math.max(...rov.thrusters.force.map(Math.abs))).toBeLessThan(1); // thrusters idle
    });
  }
});

describe('depth hold in the full simulation', () => {
  it('holds depth within ±0.3 m under the strong site current with the segment tether attached', () => {
    const sim = new Simulation('depthHold', 'free');
    sim.setConditionChoice({ ...sim.conditionChoice, current: 'strong' });
    expect(sim.releaseRov()).toBe(true);
    // Fly out 20 s, then let go of the sticks.
    sim.command.surge = 0.6;
    sim.command.heave = -0.4;
    for (let i = 0; i < 20 * 120; i++) sim.advance(DT);
    Object.assign(sim.command, zeroAxes());
    for (let i = 0; i < 10 * 120; i++) sim.advance(DT);
    const sp = sim.controller.depthSetpoint;
    expect(sp).not.toBeNull();
    let worst = 0;
    let drift = 0;
    const p0 = sim.rov.position.clone();
    for (let i = 0; i < 60 * 120; i++) {
      sim.advance(DT);
      worst = Math.max(worst, Math.abs(sim.rov.depth - sp!));
    }
    drift = Math.hypot(sim.rov.position.x - p0.x, sim.rov.position.z - p0.z);
    expect(worst).toBeLessThan(0.3);
    expect(drift).toBeGreaterThan(1); // depth hold is not station keeping: it drifts with the current
    expect(sim.tether.tension).toBeLessThan(sim.tms.config.tensionWarn);
  });
});
