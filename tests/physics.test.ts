import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { RovController } from '../src/control/rovController';
import { ThrustAllocator } from '../src/physics/thrusters';
import { THRUSTERS } from '../src/physics/rovParams';
import { zeroAxes, type AxisCommand } from '../src/input/types';

const DT = 1 / 120;

function env(current = new Vector3(), floor = -500): PhysicsEnvironment {
  return {
    current: (_p, out) => out.copy(current),
    terrainHeight: () => floor,
    colliders: [],
  };
}

function sim(seconds: number, rov: RovPhysics, ctrl: RovController | null, cmd: Partial<AxisCommand>, e = env()) {
  const axes = { ...zeroAxes(), ...cmd };
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    ctrl?.update(axes, DT);
    rov.step(DT, e);
  }
}

function makeRov(depth = 50) {
  const rov = new RovPhysics();
  rov.reset(new Vector3(0, -depth, 0), 0);
  return rov;
}

describe('thrust allocation', () => {
  const alloc = new ThrustAllocator(THRUSTERS);
  it('reproduces any feasible wrench', () => {
    const tau: [number, number, number, number, number, number] = [800, -600, 300, 100, -250, 150];
    const f = alloc.allocate(tau);
    const back = alloc.wrenchOf(f);
    back.forEach((v, i) => expect(v).toBeCloseTo(tau[i], 3));
  });
  it('scales saturated demands preserving direction', () => {
    const tau: [number, number, number, number, number, number] = [1e5, 0, 5e4, 0, 0, 0];
    const f = alloc.allocate(tau);
    f.forEach((fi, i) => expect(Math.abs(fi)).toBeLessThanOrEqual(Math.max(THRUSTERS[i].maxForward, THRUSTERS[i].maxReverse) + 1e-6));
    const w = alloc.wrenchOf(f);
    expect(w[2] / w[0]).toBeCloseTo(0.5, 3);
  });
  it('has meaningful capacity on all six axes', () => {
    alloc.capacity.forEach((c) => expect(c).toBeGreaterThan(100));
  });
});

describe('rigid body dynamics', () => {
  it('is slightly positively buoyant: rises slowly with thrusters idle', () => {
    const rov = makeRov(50);
    sim(30, rov, null, {});
    const vz = rov.worldVelocity().y;
    expect(vz).toBeGreaterThan(0.02);
    expect(vz).toBeLessThan(0.5);
    expect(rov.depth).toBeLessThan(50);
  });

  it('accelerates progressively and reaches a plausible top speed in surge', () => {
    const rov = makeRov();
    const ctrl = new RovController(rov);
    ctrl.setMode('depthHold');
    sim(0.5, rov, ctrl, { surge: 1 });
    const early = rov.velocity.x;
    sim(30, rov, ctrl, { surge: 1 });
    const top = rov.velocity.x;
    expect(early).toBeLessThan(top * 0.5); // no instant velocity
    expect(top).toBeGreaterThan(1.2);
    expect(top).toBeLessThan(2.6); // ~2.5–5 knots
  });

  it('coasts to a stop through hydrodynamic drag (no artificial stop)', () => {
    const rov = makeRov();
    const ctrl = new RovController(rov);
    ctrl.setMode('depthHold');
    sim(20, rov, ctrl, { surge: 1 });
    sim(1, rov, ctrl, {});
    const after1s = rov.velocity.x;
    expect(after1s).toBeGreaterThan(0.3); // still gliding
    sim(25, rov, ctrl, {});
    expect(Math.abs(rov.velocity.x)).toBeLessThan(0.08);
  });

  it('is passively stable in roll and pitch (CB above CG)', () => {
    const rov = makeRov();
    rov.angularVelocity.set(0.6, 0, 0.5);
    sim(25, rov, null, {});
    expect(Math.abs(rov.roll)).toBeLessThan(2);
    expect(Math.abs(rov.pitch)).toBeLessThan(2);
  });

  it('turns at a realistic rate', () => {
    const rov = makeRov();
    const ctrl = new RovController(rov);
    ctrl.setMode('manual');
    sim(10, rov, ctrl, { yaw: 1 });
    expect(rov.yawRate).toBeGreaterThan(20);
    expect(rov.yawRate).toBeLessThan(90);
  });

  it('results do not depend strongly on the step size', () => {
    const a = makeRov();
    const b = makeRov();
    const ca = new RovController(a);
    const cb = new RovController(b);
    const cmd = { ...zeroAxes(), surge: 0.8, sway: 0.3, yaw: 0.2 };
    for (let i = 0; i < 120 * 10; i++) {
      ca.update(cmd, 1 / 120);
      a.step(1 / 120, env());
    }
    for (let i = 0; i < 240 * 10; i++) {
      cb.update(cmd, 1 / 240);
      b.step(1 / 240, env());
    }
    expect(a.position.distanceTo(b.position)).toBeLessThan(0.3);
  });

  it('drifts with the current when idle and weathervanes', () => {
    const rov = makeRov();
    const cur = new Vector3(0.3, 0, 0);
    sim(60, rov, null, {}, env(cur));
    const v = rov.worldVelocity();
    expect(v.x).toBeGreaterThan(0.2);
  });

  it('stops at the seabed and reports an impact', () => {
    const rov = makeRov(20);
    const ctrl = new RovController(rov);
    ctrl.setMode('manual');
    const e = env(new Vector3(), -24);
    sim(15, rov, ctrl, { heave: -1 }, e);
    expect(rov.position.y - 0.8).toBeGreaterThan(-24.05);
    const impacts = rov.takeImpacts();
    expect(impacts.length).toBeGreaterThan(0);
    expect(impacts[0].kind).toBe('seabed');
  });
});

describe('pilot modes', () => {
  it('DEPTH HOLD keeps depth with no input despite positive buoyancy', () => {
    const rov = makeRov(80);
    const ctrl = new RovController(rov);
    ctrl.setMode('depthHold');
    sim(90, rov, ctrl, {});
    expect(Math.abs(rov.depth - 80)).toBeLessThan(0.25);
  });

  it('MANUAL drifts in depth with no input', () => {
    const rov = makeRov(80);
    const ctrl = new RovController(rov);
    ctrl.setMode('manual');
    sim(60, rov, ctrl, {});
    expect(80 - rov.depth).toBeGreaterThan(1);
  });

  it('DEPTH HOLD latches the new depth after the pilot descends', () => {
    const rov = makeRov(40);
    const ctrl = new RovController(rov);
    ctrl.setMode('depthHold');
    sim(5, rov, ctrl, { heave: -1 });
    const released = rov.depth;
    expect(released).toBeGreaterThan(43);
    sim(40, rov, ctrl, {});
    expect(ctrl.depthSetpoint).not.toBeNull();
    expect(Math.abs(rov.depth - (ctrl.depthSetpoint ?? 0))).toBeLessThan(0.3);
    expect(Math.abs(rov.depth - released)).toBeLessThan(3);
  });

  it('STABILIZE holds heading against a cross current, MANUAL does not', () => {
    const cur = new Vector3(0.35, 0, 0.2);
    const a = makeRov();
    const ca = new RovController(a);
    ca.setMode('stabilize');
    const h0 = a.heading;
    sim(60, a, ca, {}, env(cur));
    const b = makeRov();
    const cb = new RovController(b);
    cb.setMode('manual');
    sim(60, b, cb, {}, env(cur));
    const da = Math.abs(((a.heading - h0 + 540) % 360) - 180);
    const db = Math.abs(((b.heading - h0 + 540) % 360) - 180);
    expect(da).toBeLessThan(3);
    expect(db).toBeGreaterThan(da + 5);
  });

  it('STABILIZE levels pitch while surging better than MANUAL', () => {
    const a = makeRov();
    const ca = new RovController(a);
    ca.setMode('stabilize');
    sim(20, a, ca, { surge: 1 });
    const b = makeRov();
    const cb = new RovController(b);
    cb.setMode('manual');
    sim(20, b, cb, { surge: 1 });
    expect(Math.abs(a.pitch)).toBeLessThan(1.5);
    expect(Math.abs(b.pitch)).toBeGreaterThan(Math.abs(a.pitch));
  });

  it('STABILIZE turns at the commanded rate', () => {
    const rov = makeRov();
    const ctrl = new RovController(rov);
    ctrl.setMode('stabilize');
    sim(8, rov, ctrl, { yaw: 1 });
    expect(rov.yawRate).toBeGreaterThan(30);
    expect(rov.yawRate).toBeLessThan(50);
  });
});
