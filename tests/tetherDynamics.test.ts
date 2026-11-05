import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RovPhysics, type PhysicsEnvironment } from '../src/physics/rovPhysics';
import type { TetherForceProvider } from '../src/physics/tether';
import { SegmentTether, TETHER_CONTACT } from '../src/physics/segmentTether';
import { Simulation } from '../src/sim/simulation';
import { terrainHeight } from '../src/sim/terrain';
import type { PilotMode } from '../src/control/rovController';

/**
 * Metric tests of the segment tether as the pilot feels it (v3.2 recovery):
 * where the force acts, slack/tension coherence with ROV motion and winch,
 * current, depth, seabed, long-run robustness, rendering fidelity and the
 * engineering diagnostics accessor.
 */

const DT = 1 / 120;

/** Constant world force at the termination (stub provider). */
class ConstantPull implements TetherForceProvider {
  constructor(private readonly f: Vector3) {}
  step(_dt: number, _a: Vector3, _v: Vector3, out: Vector3): Vector3 {
    return out.copy(this.f);
  }
}

/** Released ROV in the free-dive scenario, teleported once (setup only) below the TMS. */
function freeSim(payout: number, mode: PilotMode = 'depthHold', below = 8, current: 'off' | 'normal' | 'strong' = 'off') {
  const sim = new Simulation(mode, 'free');
  sim.setConditionChoice({ ...sim.conditionChoice, current });
  expect(sim.releaseRov()).toBe(true);
  sim.tms.reset(payout, 'manual');
  const ex = sim.tmsExit;
  sim.rov.reset(new Vector3(ex.x, ex.y - below, ex.z), sim.lars.yaw);
  sim.tether.payout = payout;
  sim.tether.reset(ex, sim.attachWorld());
  sim.controller.reset();
  return sim;
}

function run(sim: Simulation, seconds: number, each?: () => void) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.advance(DT);
    each?.();
  }
}

function mean(sim: Simulation, seconds: number, f: () => number): number {
  let s = 0;
  let k = 0;
  run(sim, seconds, () => {
    s += f();
    k++;
  });
  return s / k;
}

describe('tether force application point', () => {
  it('a lateral pull at the aft-top termination yaws and rolls the ROV with the right sign (not applied at the CG)', () => {
    const F = 1000;
    const kick = (attach: [number, number, number]) => {
      const rov = new RovPhysics();
      rov.reset(new Vector3(0, -100, 0), 0); // heading: body +X = world +X, body +Z (starboard) = world +Z
      rov.tetherAttach.set(...attach);
      const env: PhysicsEnvironment = { current: (_p, o) => o.set(0, 0, 0), terrainHeight: () => -1000, colliders: [], tether: new ConstantPull(new Vector3(0, 0, F)) };
      rov.step(DT, env);
      return rov;
    };
    const r = kick([-0.6, 1.05, 0]); // production termination
    const p = r.params;
    const Ix = p.inertia[0] + p.addedInertia[0];
    const Iy = p.inertia[1] + p.addedInertia[1];
    // Pull to starboard above the CG → starboard-down roll (+ωx); behind the CG → stern to starboard, bow to port (+ωy, yaw rate < 0).
    expect(r.angularVelocity.x).toBeGreaterThan(0);
    expect(r.angularVelocity.y).toBeGreaterThan(0);
    // Exact moment arms: Mx = r_y·F = 1.05 F, My = −r_x·F = 0.6 F.
    expect((r.angularVelocity.x * Ix) / DT).toBeCloseTo(1.05 * F, 0);
    expect((r.angularVelocity.y * Iy) / DT).toBeCloseTo(0.6 * F, 0);
    // Same linear effect whatever the point; no rotation if it were applied at the CG.
    const cg = kick([0, 0, 0]);
    expect(cg.velocity.z).toBeCloseTo(r.velocity.z, 9);
    expect(cg.angularVelocity.length()).toBeLessThan(1e-12);
    // Mirror pull → mirrored moments.
    const rov = new RovPhysics();
    rov.reset(new Vector3(0, -100, 0), 0);
    rov.step(DT, { current: (_p, o) => o.set(0, 0, 0), terrainHeight: () => -1000, colliders: [], tether: new ConstantPull(new Vector3(0, 0, -F)) });
    expect(rov.angularVelocity.x).toBeCloseTo(-r.angularVelocity.x, 12);
    expect(rov.angularVelocity.y).toBeCloseTo(-r.angularVelocity.y, 12);
  });

  it('in the simulation, a taut tether to port of the vehicle yaws it towards the TMS side in MANUAL', () => {
    // TMS straight to port (−Z body at heading of the TMS), slack only 0.3 m: the pull is lateral.
    const sim = freeSim(10, 'manual', 0);
    const yaw = sim.lars.yaw;
    const ex = sim.tmsExit;
    // Starboard of the TMS by 10.2 m (body +Z of heading `yaw` in world = (sin yaw, 0, cos yaw)).
    sim.rov.reset(new Vector3(ex.x + Math.sin(yaw) * 10.2, ex.y - 1.05, ex.z + Math.cos(yaw) * 10.2), yaw);
    sim.tether.reset(ex, sim.attachWorld());
    sim.controller.reset();
    sim.command.sway = 0.6; // push away to starboard
    let rate = 0;
    run(sim, 6, () => (rate = sim.rov.yawRate));
    expect(sim.tether.tension).toBeGreaterThan(200);
    // Port pull aft of the CG swings the stern to port → bow to starboard → turning right (yaw rate > 0).
    expect(rate).toBeGreaterThan(0.5);
  });
});

describe('slack / tension coherence', () => {
  it('approaching the TMS increases slack and drops tension; moving beyond the payout raises it and pulls back', () => {
    const sim = freeSim(15);
    sim.command.surge = 0.4;
    run(sim, 30);
    const tautT = sim.tether.tension;
    const tautSlack = sim.tether.slack;
    expect(tautT).toBeGreaterThan(800); // holding the vehicle's thrust
    expect(tautSlack).toBeLessThan(0.05);
    // The tether is what stops it: the vehicle no longer opens the distance.
    const d0 = sim.tether.chordLength;
    run(sim, 5);
    expect(sim.tether.chordLength - d0).toBeLessThan(0.1);
    expect(sim.tether.chordLength).toBeLessThan(15 * 1.02);
    // Fly back towards the TMS.
    sim.command.surge = -0.4;
    const slack: number[] = [];
    const tension: number[] = [];
    for (let k = 0; k < 8; k++) {
      run(sim, 1);
      slack.push(sim.tether.slack);
      tension.push(sim.tether.tension);
    }
    expect(slack[7]).toBeGreaterThan(3);
    for (let k = 2; k < 8; k++) expect(slack[k]).toBeGreaterThanOrEqual(slack[k - 1] - 0.05);
    expect(Math.max(...tension.slice(2))).toBeLessThan(60);
  });

  it('paying out reduces the tension; hauling increases it up to the haul-inhibit limit (no snap above it)', () => {
    const sim = freeSim(20);
    sim.command.surge = 0.5;
    run(sim, 25);
    const held = mean(sim, 2, () => sim.tether.tension);
    expect(held).toBeGreaterThan(1000);
    sim.tms.setCommand(true, false);
    const paying = mean(sim, 3, () => sim.tether.tension);
    expect(paying).toBeLessThan(held * 0.3);
    sim.tms.setCommand(false, false);
    run(sim, 3);
    sim.tms.setCommand(false, true);
    let maxT = 0;
    const states = new Set<string>();
    const before = sim.tether.tension;
    run(sim, 8, () => {
      maxT = Math.max(maxT, sim.tether.tension);
      states.add(sim.tms.state);
    });
    expect(maxT).toBeGreaterThan(Math.max(before, held) * 1.5); // hauling against thrust loads the line
    expect(maxT).toBeLessThan(sim.tms.config.tensionLimit * 1.05); // stall at the limit, no runaway
    expect(states.has('slip')).toBe(false);
  });

  it('hauling an idle vehicle draws it in; the chord follows the payout', () => {
    const sim = freeSim(25, 'stabilize', 8);
    sim.command.surge = 0.3;
    run(sim, 30);
    sim.command.surge = 0;
    run(sim, 5);
    const d0 = sim.tether.chordLength;
    sim.tms.setCommand(false, true);
    run(sim, 10);
    expect(sim.tms.payout).toBeLessThan(25 - 7);
    expect(sim.tether.chordLength).toBeLessThan(d0 - 4);
    expect(sim.tether.chordLength).toBeLessThanOrEqual(sim.tms.payout + 0.3);
  });

  it('a lateral current bows the slack tether downstream (mid-node displaced along the current)', () => {
    const bow = (speed: number) => {
      const t = new SegmentTether((_p, out) => out.set(0, 0, speed), {}, () => -1000);
      t.payout = 40;
      const a = new Vector3(0, -50, 0);
      const b = new Vector3(25, -60, 0);
      t.reset(a, b);
      const f = new Vector3();
      for (let i = 0; i < 30 / DT; i++) t.step(DT, b, new Vector3(), f);
      return { mid: t.p[t.n >> 1].z, quarter: t.p[t.n >> 2].z, fz: f.z };
    };
    const still = bow(0);
    const slow = bow(0.25);
    const fast = bow(0.5);
    expect(Math.abs(still.mid)).toBeLessThan(0.05);
    expect(slow.mid).toBeGreaterThan(1);
    expect(fast.mid).toBeGreaterThan(slow.mid);
    expect(fast.mid).toBeGreaterThan(fast.quarter); // largest in the middle
    expect(fast.fz).toBeGreaterThan(0); // the ROV is dragged downstream too
  });

  it('depth change in AUTO: the winch pays out as the vehicle dives, slack kept, tension low', () => {
    const sim = freeSim(10, 'stabilize', 5);
    sim.tms.reset(10, 'auto');
    sim.command.heave = -0.7;
    let maxT = 0;
    let minSlack = Infinity;
    run(sim, 25, () => {
      maxT = Math.max(maxT, sim.tether.tension);
      if (sim.rov.time > 3) minSlack = Math.min(minSlack, sim.tether.slack);
    });
    expect(sim.tmsExit.y - sim.rov.position.y).toBeGreaterThan(15); // dove ≥ 10 m more
    expect(sim.tms.payout).toBeGreaterThan(sim.tether.chordLength);
    expect(minSlack).toBeGreaterThan(0.5);
    expect(maxT).toBeLessThan(sim.tms.config.tensionWarn);
  });
});

describe('seabed and long-run robustness (simulation)', () => {
  it('slack tether near the seabed rests on it: every node stays above the terrain', () => {
    const sim = freeSim(60, 'depthHold', 2);
    const ex = sim.tmsExit;
    // Put the vehicle 1.5 m above the seabed, 12 m off the TMS axis.
    const x = ex.x + 12;
    const z = ex.z;
    sim.rov.reset(new Vector3(x, terrainHeight(x, z) + 2.4, z), sim.lars.yaw);
    sim.tether.reset(ex, sim.attachWorld());
    sim.controller.reset();
    run(sim, 20);
    const d = sim.tether.debugState();
    for (let i = 1; i < sim.tether.n; i++) {
      expect(d.nodes[i].y).toBeGreaterThanOrEqual(terrainHeight(d.nodes[i].x, d.nodes[i].z) + sim.tether.config.radius - 1e-3);
    }
    expect(d.contacts.seabed).toBeGreaterThan(0);
    expect(Array.from(d.nodeContact).some((f) => (f & TETHER_CONTACT.seabed) !== 0)).toBe(true);
  });

  it('10 min simulated with pseudo-random pilot and winch inputs: finite, bounded, no explosion', () => {
    let seed = 20261105;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const sim = new Simulation('stabilize', 'free');
    sim.setConditionChoice({ ...sim.conditionChoice, current: 'strong' });
    expect(sim.releaseRov()).toBe(true);
    const modes: PilotMode[] = ['manual', 'stabilize', 'depthHold'];
    let maxF = 0;
    let maxV = 0;
    let maxStep = 0;
    let maxExcess = 0;
    const prev = sim.rov.position.clone();
    for (let i = 0; i < 120 * 600; i++) {
      if (i % (120 * 6) === 0) {
        sim.command.surge = rnd() * 2 - 1;
        sim.command.sway = rnd() * 2 - 1;
        sim.command.heave = rnd() * 1.6 - 0.8;
        sim.command.yaw = rnd() * 2 - 1;
        sim.setMode(modes[Math.floor(rnd() * 3)]);
        const w = rnd();
        if (w < 0.4) sim.tms.mode = 'auto';
        else {
          sim.tms.mode = 'manual';
          sim.tms.setCommand(w < 0.7, w >= 0.7 && w < 0.85);
        }
      }
      sim.advance(DT);
      const t = sim.tether;
      maxF = Math.max(maxF, t.force.length());
      maxV = Math.max(maxV, sim.rov.velocity.length());
      maxStep = Math.max(maxStep, sim.rov.position.distanceTo(prev));
      maxExcess = Math.max(maxExcess, t.chordLength - t.payout);
      prev.copy(sim.rov.position);
      if (!Number.isFinite(sim.rov.position.x + sim.rov.position.y + sim.rov.position.z + t.tension + t.payout)) throw new Error(`non-finite at step ${i}`);
    }
    expect(sim.lars.state).toBe('released');
    expect(sim.tether.p.every((p) => Number.isFinite(p.x + p.y + p.z))).toBe(true);
    expect(maxF).toBeLessThanOrEqual(sim.tether.config.maxForce + 10);
    expect(maxV).toBeLessThan(4);
    expect(maxStep).toBeLessThan(4 / 120); // no teleport
    expect(maxExcess).toBeLessThan(1.5); // never far beyond the paid-out length
    expect(sim.tms.payout).toBeLessThanOrEqual(sim.tms.config.maxLength);
    expect(sim.tms.payout).toBeGreaterThanOrEqual(sim.tms.config.minLength);
  }, 60_000);
});

describe('rendering fidelity and diagnostics', () => {
  it('the polyline is exactly the physical nodes, from the TMS exit to the ROV termination', () => {
    const sim = freeSim(20, 'stabilize', 6, 'normal');
    sim.command.surge = 0.6;
    sim.command.sway = 0.3;
    run(sim, 10);
    const pts = sim.tether.polyline(16);
    expect(pts.length).toBe(sim.tether.n + 1);
    pts.forEach((p, i) => expect(p.distanceTo(sim.tether.p[i])).toBe(0));
    expect(pts[0].distanceTo(sim.tmsExit)).toBeLessThan(1e-9);
    expect(pts[pts.length - 1].distanceTo(sim.attachWorld())).toBeLessThan(1e-9);
    // Reuses the output array.
    expect(sim.tether.polyline(16, pts)).toBe(pts);
    // Consecutive nodes never further apart than the stretched segment length.
    for (let i = 0; i < pts.length - 1; i++) expect(pts[i].distanceTo(pts[i + 1])).toBeLessThan(sim.tether.restLength * 1.1);
  });

  it('debugState(): nodes, per-segment tension, attach force and contacts, consistent with the scalars', () => {
    const sim = freeSim(15);
    sim.command.surge = 0.5;
    run(sim, 25);
    const d = sim.tether.debugState();
    const n = sim.tether.n;
    expect(d.nodes.length).toBe(n + 1);
    expect(d.segmentTension.length).toBe(n);
    expect(d.segmentStrain.length).toBe(n);
    expect(d.nodeContact.length).toBe(n + 1);
    expect(d.attachForce.distanceTo(sim.tether.force)).toBe(0);
    expect(d.tension).toBe(sim.tether.tension);
    expect(d.payout).toBe(15);
    expect(d.enabled).toBe(true);
    expect(d.rovContactSuspended).toBe(false);
    // Taut: every segment carries load, of the order of the termination tension.
    const segs = Array.from(d.segmentTension);
    expect(Math.min(...segs)).toBeGreaterThan(0.3 * d.tension);
    expect(segs[n - 1]).toBe(d.tension);
    const median = segs.slice().sort((a, b) => a - b)[n >> 1];
    expect(median).toBeGreaterThan(0.5 * d.tension);
    expect(median).toBeLessThan(2 * d.tension);
    // The force on the ROV points back towards the cable (towards the TMS side).
    const toTms = sim.tmsExit.sub(sim.attachWorld()).normalize();
    expect(d.attachForce.clone().normalize().dot(toTms)).toBeGreaterThan(0.8);
    // Reused object (no per-frame allocation) and a snapshot (not live).
    const again = sim.tether.debugState();
    expect(again).toBe(d);
    const x = d.nodes[3].x;
    d.nodes[3].x += 100;
    expect(sim.tether.p[3].x).toBeCloseTo(x, 9);
  });

  it('release under the TMS: no tension spike and no jump (cable laid clear, ROV contact suspended at the exit)', () => {
    const sim = new Simulation('stabilize', 'free');
    run(sim, 1);
    const prev = sim.rov.position.clone();
    expect(sim.releaseRov()).toBe(true);
    let maxT = 0;
    let maxSeg = 0;
    let maxStep = 0;
    run(sim, 3, () => {
      maxT = Math.max(maxT, sim.tether.tension);
      maxSeg = Math.max(maxSeg, ...sim.tether.debugState().segmentTension);
      maxStep = Math.max(maxStep, sim.rov.position.distanceTo(prev));
      prev.copy(sim.rov.position);
    });
    expect(maxT).toBeLessThan(50);
    expect(maxSeg).toBeLessThan(200);
    expect(maxStep).toBeLessThan(0.005);
    expect(sim.tether.debugState().rovContactSuspended).toBe(true);
  });
});
