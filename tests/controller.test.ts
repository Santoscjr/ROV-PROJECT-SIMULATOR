import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { RovController, type PilotMode } from '../src/control/rovController';
import { Tether } from '../src/physics/tether';
import { THRUSTERS } from '../src/physics/rovParams';
import { zeroAxes, type AxisCommand } from '../src/input/types';

const DT = 1 / 120;

function env(current = new Vector3(), floor = -500, tether = false, rov?: RovPhysics): PhysicsEnvironment {
  const e: PhysicsEnvironment = { current: (_p, out) => out.copy(current), terrainHeight: () => floor, colliders: [] };
  if (tether && rov) {
    const t = new Tether((p, out) => (p.y < 0 ? out.copy(current) : out.set(0, 0, 0)));
    t.reset(new Vector3(-30, 0, 0), rov.position);
    e.tether = t;
  }
  return e;
}

function setup(depth: number, mode: PilotMode) {
  const rov = new RovPhysics();
  rov.reset(new Vector3(0, -depth, 0), 0);
  const ctrl = new RovController(rov);
  ctrl.mode = mode;
  ctrl.reset();
  return { rov, ctrl };
}

function sim(rov: RovPhysics, ctrl: RovController, seconds: number, cmd: Partial<AxisCommand>, e: PhysicsEnvironment, each?: () => void) {
  const axes = { ...zeroAxes(), ...cmd };
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    ctrl.update(axes, DT);
    rov.step(DT, e);
    each?.();
  }
}

/** Largest per-step change of any thruster command (fraction of its forward limit). */
function maxCommandStep(rov: RovPhysics, ctrl: RovController, seconds: number, cmd: Partial<AxisCommand>, e: PhysicsEnvironment): number {
  let prev = [...rov.thrusters.command];
  let worst = 0;
  sim(rov, ctrl, seconds, cmd, e, () => {
    rov.thrusters.command.forEach((c, i) => (worst = Math.max(worst, Math.abs(c - prev[i]) / THRUSTERS[i].maxForward)));
    prev = [...rov.thrusters.command];
  });
  return worst;
}

describe('bumpless mode transfer', () => {
  it('switching modes does not step the thruster commands', () => {
    const cur = new Vector3(0.3, 0, 0.2);
    const { rov, ctrl } = setup(60, 'manual');
    const e = env(cur);
    const cmd = { surge: 0.5, yaw: 0.6, heave: -0.4 };
    sim(rov, ctrl, 6, cmd, e);
    // Baseline: how much the commands move per step while nothing changes.
    const steady = maxCommandStep(rov, ctrl, 1, cmd, e);
    const limit = Math.max(0.035, steady * 1.5); // ≤ 3.5 % of max thrust per 1/120 s step

    ctrl.setMode('stabilize');
    expect(maxCommandStep(rov, ctrl, 1.5, cmd, e)).toBeLessThan(limit);
    // Release the sticks while in STABILIZE, then go to DEPTH HOLD while still moving.
    sim(rov, ctrl, 3, {}, e);
    ctrl.setMode('depthHold');
    expect(maxCommandStep(rov, ctrl, 1.5, {}, e)).toBeLessThan(limit);
    sim(rov, ctrl, 10, {}, e);
    ctrl.setMode('manual');
    expect(maxCommandStep(rov, ctrl, 1.5, {}, e)).toBeLessThan(limit);
    sim(rov, ctrl, 3, { surge: 0.4 }, e); // stick change happens before the switch
    ctrl.setMode('depthHold');
    expect(maxCommandStep(rov, ctrl, 1.5, { surge: 0.4 }, e)).toBeLessThan(limit);
  });

  it('assist authority ramps over ~0.5 s and is reported in status()', () => {
    const { rov, ctrl } = setup(60, 'manual');
    const e = env();
    sim(rov, ctrl, 1, {}, e);
    expect(ctrl.status().assistAttitude).toBe(0);
    ctrl.setMode('depthHold');
    sim(rov, ctrl, 0.25, {}, e);
    const mid = ctrl.status();
    expect(mid.assistAttitude).toBeGreaterThan(0.4);
    expect(mid.assistAttitude).toBeLessThan(0.6);
    sim(rov, ctrl, 0.3, {}, e);
    expect(ctrl.status().assistAttitude).toBe(1);
    expect(ctrl.status().assistDepth).toBe(1);
    expect(ctrl.status().depthSetpoint).not.toBeNull();
  });

  it('does not latch a depth while the vehicle is still moving vertically (no swing-back)', () => {
    const { rov, ctrl } = setup(40, 'stabilize');
    const e = env();
    sim(rov, ctrl, 4, { heave: -1 }, e);
    const vz = rov.worldVelocity().y;
    expect(vz).toBeLessThan(-0.3);
    ctrl.setMode('depthHold');
    expect(ctrl.depthSetpoint).toBeNull();
    const atSwitch = rov.depth;
    let maxDepth = 0;
    sim(rov, ctrl, 30, {}, e, () => (maxDepth = Math.max(maxDepth, rov.depth)));
    const sp = ctrl.depthSetpoint!;
    expect(sp).toBeGreaterThan(atSwitch);
    expect(maxDepth - sp).toBeLessThan(0.3);
    expect(Math.abs(rov.depth - sp)).toBeLessThan(0.15);
  });
});

describe('heading hold', () => {
  it('captures the heading after a fast turn without overshoot', () => {
    const { rov, ctrl } = setup(60, 'stabilize');
    const e = env();
    sim(rov, ctrl, 6, { yaw: 1 }, e);
    const errors: number[] = [];
    sim(rov, ctrl, 15, {}, e, () => {
      if (ctrl.headingSetpoint !== null) errors.push(((ctrl.headingSetpoint - rov.heading + 540) % 360) - 180);
    });
    expect(errors.length).toBeGreaterThan(0);
    // Turning right: heading must approach the setpoint from below and never pass it by more than 0.3°.
    expect(Math.min(...errors)).toBeGreaterThan(-0.3);
    expect(Math.abs(errors[errors.length - 1])).toBeLessThan(0.2);
  });

  it('holds heading under a strong (0.5 m/s) cross current with the umbilical', () => {
    const cur = new Vector3(0, 0, 0.5);
    const { rov, ctrl } = setup(80, 'stabilize');
    const e = env(cur, -500, true, rov);
    const h0 = rov.heading;
    let worst = 0;
    sim(rov, ctrl, 120, {}, e, () => {
      if (rov.time > 10) worst = Math.max(worst, Math.abs(((rov.heading - h0 + 540) % 360) - 180));
    });
    expect(worst).toBeLessThan(2);
  });
});

describe('depth hold', () => {
  it('holds depth within ±0.25 m under a strong (0.5 m/s) current with the umbilical', () => {
    const cur = new Vector3(0.35, 0, 0.35);
    const { rov, ctrl } = setup(80, 'depthHold');
    const e = env(cur, -500, true, rov);
    let worst = 0;
    sim(rov, ctrl, 120, {}, e, () => {
      if (rov.time > 15) worst = Math.max(worst, Math.abs(rov.depth - 80));
    });
    expect(worst).toBeLessThan(0.25);
  });

  it('does not fight the pilot: climbs as fast as in STABILIZE', () => {
    const a = setup(80, 'depthHold');
    const b = setup(80, 'stabilize');
    sim(a.rov, a.ctrl, 20, {}, env());
    sim(b.rov, b.ctrl, 20, {}, env());
    const da = a.rov.depth;
    const db = b.rov.depth;
    sim(a.rov, a.ctrl, 8, { heave: 0.5 }, env());
    sim(b.rov, b.ctrl, 8, { heave: 0.5 }, env());
    const climbA = da - a.rov.depth;
    const climbB = db - b.rov.depth;
    expect(climbA).toBeGreaterThan(climbB * 0.85);
  });

  it('does not wind up while sitting on the seabed (anti-windup)', () => {
    const e = env(new Vector3(), -24);
    const { rov, ctrl } = setup(20, 'depthHold');
    sim(rov, ctrl, 15, { heave: -0.6 }, e); // land
    ctrl.depthSetpoint = 26; // below the seabed: unreachable
    sim(rov, ctrl, 60, {}, e);
    expect(rov.contactCount).toBeGreaterThan(0);
    // New target 3 m up: the vehicle must get there promptly and without a big overshoot.
    const target = rov.depth - 3;
    ctrl.depthSetpoint = target;
    let tReach = -1;
    let minDepth = Infinity;
    sim(rov, ctrl, 30, {}, e, () => {
      minDepth = Math.min(minDepth, rov.depth);
      if (tReach < 0 && Math.abs(rov.depth - target) < 0.3) tReach = rov.time;
    });
    expect(tReach).toBeGreaterThan(0);
    expect(target - minDepth).toBeLessThan(0.5);
    expect(Math.abs(rov.depth - target)).toBeLessThan(0.15);
  });

  it('reports saturation when all axes are demanded at once (power budget)', () => {
    const { rov, ctrl } = setup(60, 'manual');
    sim(rov, ctrl, 3, { surge: 1, heave: 1 }, env());
    const s = ctrl.status();
    expect(s.saturation).toBeLessThan(0.9);
    expect(rov.thrusters.powerFraction).toBeGreaterThan(0.95);
    expect(rov.thrusters.powerFraction).toBeLessThanOrEqual(1);
  });
});
