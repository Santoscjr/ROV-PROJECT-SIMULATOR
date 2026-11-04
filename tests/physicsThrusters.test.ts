import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ThrusterBank, ThrustAllocator, THRUSTER_DEFAULTS, type Wrench } from '../src/physics/thrusters';
import { DEFAULT_ROV_PARAMS, THRUSTERS } from '../src/physics/rovParams';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { RovController } from '../src/control/rovController';
import { zeroAxes } from '../src/input/types';

const DT = 1 / 120;
const BUDGET = DEFAULT_ROV_PARAMS.powerBudget!;

function run(bank: ThrusterBank, seconds: number) {
  for (let i = 0; i < Math.round(seconds / DT); i++) bank.step(DT);
}

describe('thruster dynamics', () => {
  it('spins up with an S-shaped force response (motor lag + slew limit + n|n|)', () => {
    const bank = new ThrusterBank(THRUSTERS, BUDGET);
    const cmd = THRUSTERS.map((_, i) => (i === 4 ? THRUSTERS[4].maxForward : 0));
    bank.setCommand(cmd);
    let t10 = -1;
    let t90 = -1;
    let at01 = 0;
    for (let k = 1; k <= 240; k++) {
      bank.step(DT);
      const l = bank.level(4);
      if (k === 12) at01 = l;
      if (t10 < 0 && l >= 0.1) t10 = k * DT;
      if (t90 < 0 && l >= 0.9) t90 = k * DT;
    }
    // Slow start: after 0.1 s only a few % of thrust (a first-order force lag of 0.3 s would give 28 %).
    expect(at01).toBeLessThan(0.12);
    expect(t10).toBeGreaterThan(0.08);
    expect(t90).toBeGreaterThan(0.35);
    expect(t90).toBeLessThan(0.9);
    expect(bank.level(4)).toBeCloseTo(1, 3);
    expect(bank.speed[4]).toBeCloseTo(1, 3);
  });

  it('thrust follows n|n| with forward/reverse asymmetry', () => {
    const bank = new ThrusterBank(THRUSTERS);
    const f = THRUSTERS.map((t, i) => (i % 2 === 0 ? 0.25 * t.maxForward : -0.25 * t.maxReverse));
    bank.setCommand(f);
    run(bank, 3);
    THRUSTERS.forEach((t, i) => {
      const n = bank.speed[i];
      expect(Math.abs(n)).toBeCloseTo(0.5, 3);
      const fmax = n >= 0 ? t.maxForward : t.maxReverse;
      expect(bank.force[i]).toBeCloseTo(fmax * n * Math.abs(n), 6);
      expect(bank.force[i]).toBeCloseTo(f[i], 3);
      expect(bank.load(i)).toBeCloseTo(0.125, 3); // power ∝ |n|³
    });
    // Mid-transient the law still holds.
    bank.setCommand(THRUSTERS.map((t) => t.maxForward));
    bank.step(DT * 7);
    const n0 = bank.speed[0];
    expect(bank.force[0]).toBeCloseTo(THRUSTERS[0].maxForward * n0 * Math.abs(n0), 6);
    // Full reverse reaches the (lower) reverse limit.
    bank.setCommand(THRUSTERS.map((t) => -t.maxReverse));
    run(bank, 3);
    expect(bank.force[0]).toBeCloseTo(-THRUSTERS[0].maxReverse, 1);
    expect(bank.level(0)).toBeCloseTo(-1, 3);
  });

  it('reverses through zero no faster than the slew limit', () => {
    const bank = new ThrusterBank(THRUSTERS);
    bank.setCommand(THRUSTERS.map((t) => t.maxForward));
    run(bank, 3);
    bank.setCommand(THRUSTERS.map((t) => -t.maxReverse));
    let prev = bank.speed[0];
    let maxRate = 0;
    for (let k = 0; k < 240; k++) {
      bank.step(DT);
      maxRate = Math.max(maxRate, Math.abs(bank.speed[0] - prev) / DT);
      prev = bank.speed[0];
    }
    expect(maxRate).toBeLessThanOrEqual(THRUSTER_DEFAULTS.slewRate + 1e-9);
  });

  it('shares one power budget: full demand on all axes saturates, preserving wrench direction', () => {
    const alloc = new ThrustAllocator(THRUSTERS);
    // Surge + heave at the largest level the thrusters themselves can deliver.
    const want: Wrench = [alloc.capacity[0], alloc.capacity[1], 0, 0, 0, 0];
    const cmd = alloc.allocate(want);
    const tau = alloc.wrenchOf(cmd);
    const bank = new ThrusterBank(THRUSTERS, BUDGET);
    bank.setCommand(cmd);
    expect(bank.powerScale).toBeLessThan(0.95); // feasible for the thrusters, not for the HPU
    run(bank, 4);
    expect(bank.powerFraction).toBeLessThanOrEqual(1 + 1e-9);
    expect(bank.powerFraction).toBeGreaterThan(0.97);
    expect(bank.power).toBeLessThanOrEqual(BUDGET * (1 + 1e-9));
    const w = alloc.wrenchOf(bank.force);
    expect(w[0]).toBeLessThan(tau[0] * 0.9);
    expect(w[1] / w[0]).toBeCloseTo(tau[1] / tau[0], 3);
    expect(Math.abs(w[2]) + Math.abs(w[3]) + Math.abs(w[4]) + Math.abs(w[5])).toBeLessThan(1);
  });

  it('a single axis at full demand stays within budget (no scaling)', () => {
    const alloc = new ThrustAllocator(THRUSTERS);
    const bank = new ThrusterBank(THRUSTERS, BUDGET);
    bank.setCommand(alloc.allocate([0, alloc.capacity[1], 0, 0, 0, 0]));
    run(bank, 3);
    expect(bank.powerScale).toBe(1);
    expect(bank.powerFraction).toBeLessThan(1);
    expect(bank.powerFraction).toBeGreaterThan(0.5);
  });

  it('never exceeds the budget during transients', () => {
    const bank = new ThrusterBank(THRUSTERS, BUDGET);
    const alloc = new ThrustAllocator(THRUSTERS);
    const taus: Wrench[] = [
      [alloc.capacity[0], alloc.capacity[1], 0, 0, 0, 0],
      [-alloc.capacity[0], -alloc.capacity[1], 0, 0, 0, 0],
      [0, alloc.capacity[1], alloc.capacity[2], 0, alloc.capacity[4], 0],
    ];
    let maxP = 0;
    for (let k = 0; k < 600; k++) {
      if (k % 100 === 0) bank.setCommand(alloc.allocate(taus[(k / 100) % 3]));
      bank.step(DT);
      maxP = Math.max(maxP, bank.power);
    }
    expect(maxP).toBeLessThanOrEqual(BUDGET * (1 + 1e-9));
  });

  it('loses thrust with inflow along the thrust axis (advance ratio), gains a little against it', () => {
    const bank = new ThrusterBank(THRUSTERS);
    bank.setCommand(THRUSTERS.map((t) => t.maxForward));
    run(bank, 3);
    const bollard = bank.force[0];
    bank.inflow.fill(2);
    bank.step(DT);
    const advancing = bank.force[0];
    expect(advancing / bollard).toBeCloseTo(1 - 2 / THRUSTER_DEFAULTS.advanceSpeed, 3);
    bank.inflow.fill(-2);
    bank.step(DT);
    const braking = bank.force[0];
    expect(braking).toBeGreaterThan(bollard);
    expect(braking).toBeLessThanOrEqual(bollard * 1.15 * (1 + 1e-6));
    // Reverse thrust: inflow along −direction is the advancing case.
    bank.setCommand(THRUSTERS.map((t) => -t.maxReverse));
    bank.inflow.fill(0);
    run(bank, 3);
    const rev = bank.force[0];
    bank.inflow.fill(-2);
    bank.step(DT);
    expect(Math.abs(bank.force[0])).toBeLessThan(Math.abs(rev));
  });

  it('the vehicle feels the advance loss at speed', () => {
    const rov = new RovPhysics();
    rov.reset(new Vector3(0, -50, 0), 0);
    const ctrl = new RovController(rov);
    ctrl.setMode('depthHold');
    const env: PhysicsEnvironment = { current: (_p, o) => o.set(0, 0, 0), terrainHeight: () => -500, colliders: [] };
    for (let i = 0; i < 120 * 30; i++) {
      ctrl.update({ ...zeroAxes(), surge: 1 }, DT);
      rov.step(DT, env);
    }
    expect(rov.velocity.x).toBeGreaterThan(1.2);
    // Horizontal thrusters are at full speed but deliver less than their bollard pull.
    expect(Math.abs(rov.thrusters.speed[0])).toBeGreaterThan(0.95);
    expect(rov.thrusters.level(0)).toBeLessThan(0.92);
    expect(rov.thrusters.inflow[0]).toBeGreaterThan(0.8);
  });
});
