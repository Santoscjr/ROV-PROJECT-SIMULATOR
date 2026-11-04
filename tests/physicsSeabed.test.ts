import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { RovController } from '../src/control/rovController';
import { zeroAxes, type AxisCommand } from '../src/input/types';

const DT = 1 / 120;
const FLOOR = -24;

function env(current = new Vector3(), floor = FLOOR): PhysicsEnvironment {
  return { current: (_p, out) => out.copy(current), terrainHeight: () => floor, colliders: [] };
}

function setup(depth: number) {
  const rov = new RovPhysics();
  rov.reset(new Vector3(0, -depth, 0), 0);
  const ctrl = new RovController(rov);
  ctrl.mode = 'manual';
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

describe('near-bottom behaviour', () => {
  it('seabedDisturbance rises when the vertical jets wash the bottom, ~0 at altitude', () => {
    const e = env();
    const low = setup(20);
    sim(low.rov, low.ctrl, 15, { heave: -0.5 }, e); // land
    // Pushing down = jets pointing up: the bottom is not washed.
    expect(low.rov.seabedDisturbance).toBeLessThan(0.1);
    let peak = 0;
    sim(low.rov, low.ctrl, 1.5, { heave: 1 }, e, () => (peak = Math.max(peak, low.rov.seabedDisturbance)));
    expect(peak).toBeGreaterThan(0.5);
    expect(low.rov.seabedDisturbancePoint.y).toBe(FLOOR);

    const high = setup(4);
    sim(high.rov, high.ctrl, 3, { heave: 1 }, env(new Vector3(), -200));
    expect(high.rov.seabedDisturbance).toBeLessThan(0.01);

    // Decays slowly once the vehicle has climbed away.
    sim(low.rov, low.ctrl, 10, { heave: 1 }, e);
    expect(low.rov.altitude(e)!).toBeGreaterThan(4);
    expect(low.rov.seabedDisturbance).toBeLessThan(0.2);
  });

  it('a hard landing kicks up silt', () => {
    const { rov, ctrl } = setup(18);
    let peak = 0;
    sim(rov, ctrl, 12, { heave: -1 }, env(), () => (peak = Math.max(peak, rov.seabedDisturbance)));
    expect(rov.takeImpacts().length).toBeGreaterThan(0);
    expect(peak).toBeGreaterThan(0.3);
  });

  it('rests on the seabed without jitter, holding against a light current', () => {
    const e = env(new Vector3(0.1, 0, 0.05));
    const { rov, ctrl } = setup(20);
    sim(rov, ctrl, 15, { heave: -0.5 }, e);
    const ys: number[] = [];
    let maxW = 0;
    const x0 = rov.position.clone();
    sim(rov, ctrl, 10, { heave: -0.5 }, e, () => {
      ys.push(rov.position.y);
      maxW = Math.max(maxW, rov.angularVelocity.length());
    });
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.002);
    expect(maxW).toBeLessThan(1e-3);
    expect(rov.position.distanceTo(x0)).toBeLessThan(0.02);
    expect(rov.takeImpacts().filter((i) => i.time > 15).length).toBe(0);
  });

  it('slides with plausible (Coulomb) friction: gradual stop, shorter than in free water', () => {
    const e = env();
    const { rov, ctrl } = setup(20);
    sim(rov, ctrl, 12, { heave: -0.4 }, e);
    sim(rov, ctrl, 8, { heave: -0.4, surge: 1 }, e);
    const v0 = rov.velocity.x;
    expect(v0).toBeGreaterThan(0.8); // can still be driven along the bottom
    const xStart = rov.position.x;
    sim(rov, ctrl, 0.5, { heave: -0.4 }, e);
    expect(rov.velocity.x).toBeGreaterThan(v0 * 0.5); // no "glue"
    sim(rov, ctrl, 20, { heave: -0.4 }, e);
    expect(Math.abs(rov.velocity.x)).toBeLessThan(0.02);
    const slide = rov.position.x - xStart;

    // Same speed in free water, same coast time: travels further.
    const free = setup(60);
    sim(free.rov, free.ctrl, 8, { surge: 1 }, env(new Vector3(), -500));
    free.rov.velocity.x = v0;
    const xf = free.rov.position.x;
    sim(free.rov, free.ctrl, 20.5, {}, env(new Vector3(), -500));
    expect(slide).toBeLessThan(free.rov.position.x - xf);
    expect(slide).toBeGreaterThan(0.3);
  });
});
