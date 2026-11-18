import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Tether, DEFAULT_TETHER } from '../src/physics/tether';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import { RovController } from '../src/control/rovController';
import { zeroAxes, type AxisCommand } from '../src/input/types';

const DT = 1 / 120;
const ZERO = new Vector3();

/** Uniform current below the surface. */
const uniform = (c: Vector3) => (p: Vector3, out: Vector3) => (p.y < 0 ? out.copy(c) : out.set(0, 0, 0));

/** Settle a static tether (no ROV motion) and return the force. */
function settle(t: Tether, attach: Vector3, seconds = 5): Vector3 {
  const f = new Vector3();
  for (let i = 0; i < Math.round(seconds / DT); i++) t.step(DT, attach, ZERO, f);
  return f;
}

describe('umbilical (quasi-static tether)', () => {
  it('cable drag pushes the ROV down-current', () => {
    const t = new Tether(uniform(new Vector3(0.5, 0, 0)));
    const attach = new Vector3(0, -150, 0);
    t.reset(new Vector3(0, 0, 0), attach);
    const f = settle(t, attach);
    expect(f.x).toBeGreaterThan(50);
    expect(Math.abs(f.z)).toBeLessThan(1e-6);
    expect(t.tension).toBe(0); // slack: no winch pull
    // The bow follows the current too.
    expect(t.sagDirection.x).toBeGreaterThan(0.9);
    const mid = t.polyline(9)[4];
    expect(mid.x).toBeGreaterThan(5);
  });

  it('drag grows with paid-out length and with current²', () => {
    const fAt = (speed: number, depth: number) => {
      const t = new Tether(uniform(new Vector3(0, 0, speed)), { wetWeight: 0 });
      const a = new Vector3(0, -depth, 0);
      t.reset(new Vector3(), a);
      return settle(t, a).z;
    };
    const slow = fAt(0.25, 150);
    const fast = fAt(0.5, 150);
    expect(fast / slow).toBeGreaterThan(3.5);
    expect(fast / slow).toBeLessThan(4.5);
    expect(fAt(0.5, 300)).toBeGreaterThan(fast * 1.7);
  });

  it('auto-payout follows the ROV within the rate limit and keeps slack', () => {
    const t = new Tether(uniform(ZERO));
    const a = new Vector3(0, -50, 0);
    t.reset(new Vector3(), a);
    const f = new Vector3();
    // ROV moves away at 1 m/s for 60 s.
    for (let i = 0; i < 120 * 60; i++) {
      a.x += 1 * DT;
      t.step(DT, a, new Vector3(1, 0, 0), f);
    }
    expect(t.payout).toBeGreaterThan(t.chordLength);
    expect(t.tension).toBe(0);
  });

  it('becomes taut and pulls back when the distance exceeds the payout', () => {
    const t = new Tether(uniform(ZERO), { wetWeight: 0, teleportDistance: 50 });
    t.reset(new Vector3(), new Vector3(0, -100, 0));
    t.autoPayout = false;
    t.payout = 100;
    const f = new Vector3();
    t.step(DT, new Vector3(0, -95, 0), ZERO, f);
    expect(t.tension).toBe(0);
    t.step(DT, new Vector3(0, -100.3, 0), ZERO, f);
    expect(t.tension).toBeCloseTo(DEFAULT_TETHER.stiffness * 0.3, 0);
    expect(f.y).toBeGreaterThan(0); // towards the anchor
    expect(f.length()).toBeLessThanOrEqual(DEFAULT_TETHER.maxForce + 1e-6);
  });

  it('stops paying out at max length', () => {
    const t = new Tether(uniform(ZERO), { maxLength: 200 });
    const a = new Vector3(0, -50, 0);
    t.reset(new Vector3(), a);
    const f = new Vector3();
    for (let i = 0; i < 120 * 200; i++) {
      if (a.x < 260) a.x += 1.2 * DT;
      t.step(DT, a, new Vector3(a.x < 260 ? 1.2 : 0, 0, 0), f);
    }
    expect(t.atMaxLength).toBe(true);
    expect(t.payout).toBeCloseTo(200, 6);
    expect(t.tension).toBeGreaterThan(0);
    expect(f.x).toBeLessThan(0);
  });

  it('polyline: ≤ 24 points from anchor to ROV, above the seabed', () => {
    const t = new Tether(uniform(new Vector3(0.4, 0, 0)), {}, () => -60);
    const a = new Vector3(40, -59, 0);
    t.reset(new Vector3(0, 0, 0), a);
    settle(t, a);
    const pts = t.polyline(100);
    expect(pts.length).toBeLessThanOrEqual(24);
    expect(pts[0].distanceTo(t.anchor)).toBeLessThan(1e-9);
    expect(pts[pts.length - 1].distanceTo(a)).toBeLessThan(1e-9);
    for (const p of pts.slice(1, -1)) {
      expect(p.y).toBeGreaterThanOrEqual(-60);
      expect(p.y).toBeLessThanOrEqual(0);
    }
    // Reuses the output array.
    const again = t.polyline(16, pts);
    expect(again).toBe(pts);
    expect(again.length).toBe(16);
  });

  it('applies force and torque to the ROV: drifts down-current and tilts', () => {
    const cur = new Vector3(0.4, 0, 0);
    const mk = (withTether: boolean) => {
      const rov = new RovPhysics();
      rov.reset(new Vector3(0, -100, 0), 0);
      const env: PhysicsEnvironment = { current: (_p, o) => o.copy(ZERO), terrainHeight: () => -500, colliders: [] };
      if (withTether) {
        const t = new Tether(uniform(cur));
        t.reset(new Vector3(0, 0, 0), rov.position);
        env.tether = t;
      }
      for (let i = 0; i < 120 * 20; i++) rov.step(DT, env);
      return rov;
    };
    const free = mk(false);
    const tethered = mk(true);
    expect(tethered.position.x - free.position.x).toBeGreaterThan(0.5);
    expect(tethered.tetherForce.x).toBeGreaterThan(0);
  });

  it('is stable over 10 min with random commands and teleports (no NaN, bounded)', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const rov = new RovPhysics();
    rov.reset(new Vector3(0, -80, 0), 0);
    const ctrl = new RovController(rov);
    ctrl.reset();
    const shear = (p: Vector3, out: Vector3) => {
      const d = Math.max(0, -p.y);
      return p.y < 0 ? out.set(0.6 * Math.exp(-d / 80) + 0.15, 0, 0.2 * Math.sin(d / 30)) : out.set(0, 0, 0);
    };
    const tether = new Tether(shear, { maxLength: 300 }, () => -150);
    tether.reset(new Vector3(0, 2, 0), rov.position);
    const env: PhysicsEnvironment = { current: shear, terrainHeight: () => -150, colliders: [], tether };
    const cmd: AxisCommand = zeroAxes();
    let maxF = 0;
    let maxV = 0;
    const modes = ['manual', 'stabilize', 'depthHold'] as const;
    for (let i = 0; i < 120 * 600; i++) {
      if (i % (120 * 5) === 0) {
        cmd.surge = rnd() * 2 - 1;
        cmd.sway = rnd() * 2 - 1;
        cmd.heave = rnd() * 2 - 1;
        cmd.yaw = rnd() * 2 - 1;
        ctrl.setMode(modes[Math.floor(rnd() * 3)]);
      }
      if (i % (120 * 20) === 0 && i > 0) {
        // Teleport far away (beyond max length sometimes) or close to the anchor.
        rov.position.set((rnd() - 0.5) * 900, -10 - rnd() * 130, (rnd() - 0.5) * 900);
        if (rnd() < 0.3) rov.velocity.set(rnd() * 3, 0, 0);
      }
      ctrl.update(cmd, DT);
      rov.step(DT, env);
      maxF = Math.max(maxF, rov.tetherForce.length());
      maxV = Math.max(maxV, rov.velocity.length());
      if (!Number.isFinite(rov.position.x + rov.position.y + rov.position.z + rov.velocity.length() + rov.angularVelocity.length())) {
        throw new Error(`non-finite state at step ${i}`);
      }
    }
    expect(maxF).toBeLessThanOrEqual(DEFAULT_TETHER.maxForce + 1e-6);
    expect(maxV).toBeLessThan(8);
    expect(rov.angularVelocity.length()).toBeLessThan(3);
    expect(Number.isFinite(tether.payout)).toBe(true);
    for (const p of tether.polyline(24)) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });
});
