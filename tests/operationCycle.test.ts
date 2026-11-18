import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Simulation, safeTmsDepth, FIXED_DT } from '../src/sim/simulation';
import { missionById } from '../src/mission/catalog';
import { TOPHAT, type LarsState } from '../src/sim/topHat';

/**
 * Full launch → dive → recovery cycle driven only through the pilot command
 * (sim.command), the TMS winch and the LARS commands — no position teleports
 * after the initial setup. Asserts continuity (per-step displacement and its
 * change), the state sequence and the final state on deck.
 */

const DT = FIXED_DT;

interface Trace {
  states: LarsState[];
  maxStep: Record<string, number>;
  maxJerk: Record<string, number>;
}

function makeRunner(sim: Simulation) {
  const prev = sim.rov.position.clone();
  const prevD = new Vector3();
  const d = new Vector3();
  const trace: Trace = { states: [sim.lars.state], maxStep: {}, maxJerk: {} };
  let first = true;
  const step = () => {
    const ev = sim.advance(DT);
    const s = sim.lars.state;
    if (trace.states[trace.states.length - 1] !== s) trace.states.push(s);
    d.subVectors(sim.rov.position, prev);
    const len = d.length();
    trace.maxStep[s] = Math.max(trace.maxStep[s] ?? 0, len);
    if (!first) trace.maxJerk[s] = Math.max(trace.maxJerk[s] ?? 0, d.distanceTo(prevD));
    first = false;
    prevD.copy(d);
    prev.copy(sim.rov.position);
    return ev;
  };
  return { step, trace };
}

/** Pilot "autopilot" through the stick axes: bring the latch bullet under the receptacle and rise into it. */
function homingCommand(sim: Simulation) {
  const rec = sim.lars.receptacleWorld(new Vector3());
  const tip = TOPHAT.bulletTop.clone().applyQuaternion(sim.rov.orientation).add(sim.rov.position);
  const e = rec.sub(tip);
  const horiz = Math.hypot(e.x, e.z);
  const below = horiz > 0.3 ? 3 : 0; // stay 3 m under the TMS until aligned
  e.y -= below;
  const eb = e.applyQuaternion(new Quaternion().copy(sim.rov.orientation).invert());
  const vb = sim.rov.velocity;
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  sim.command.surge = clamp(0.25 * eb.x - 0.8 * vb.x, 0.6);
  sim.command.sway = clamp(0.25 * eb.z - 0.8 * vb.z, 0.6);
  sim.command.heave = clamp(0.3 * eb.y - 1.0 * vb.y, below ? 0.6 : 0.25);
  const tmsHeading = ((90 - (sim.lars.yaw * 180) / Math.PI) % 360 + 360) % 360;
  const he = ((tmsHeading - sim.rov.heading + 540) % 360) - 180;
  sim.command.yaw = Math.abs(he) > 1 ? clamp(he * 0.05, 0.5) : 0;
}

describe('operation cycle: deck → dive → excursion → recovery → deck', () => {
  it('runs the whole Top-Hat cycle without teleports or state jumps', () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.tmsDepth = 60;
    sim.reset('stabilize', missionById('inspection'));
    const { step, trace } = makeRunner(sim);
    const safe = safeTmsDepth(60);
    expect(sim.lars.state).toBe('deck');
    expect(sim.rov.position.y).toBeGreaterThan(0);

    // --- Lowering: continuous descent at the LARS winch speed, never below the safe depth.
    expect(sim.releaseRov()).toBe(false);
    expect(sim.lars.startLowering()).toBe(true);
    expect(sim.releaseRov()).toBe(false); // release while lowering: refused
    expect(sim.raiseAssembly()).toBe(false);
    let lastY = sim.lars.position.y;
    let lastRate = 0;
    let maxRate = 0;
    let maxRateChange = 0;
    let climbs = 0;
    let deepest = 0;
    while (sim.lars.state === 'lowering') {
      step();
      const rate = (lastY - sim.lars.position.y) / DT;
      lastY = sim.lars.position.y;
      deepest = Math.max(deepest, -sim.lars.position.y);
      if (rate < -1e-9) climbs++;
      maxRate = Math.max(maxRate, rate);
      maxRateChange = Math.max(maxRateChange, Math.abs(rate - lastRate));
      lastRate = rate;
      // Latched: the ROV rides exactly with the TMS.
      expect(sim.rov.position.distanceTo(sim.lars.dockPosition(new Vector3()))).toBeLessThan(1e-9);
      if (sim.rov.time > 400) throw new Error('lowering did not finish');
    }
    expect(sim.lars.state).toBe('atDepth');
    // Cruise at the winch speed, ramped start and stop (≤ winchAccel), never upwards.
    expect(maxRate).toBeCloseTo(sim.lars.winchSpeed, 6);
    expect(maxRateChange).toBeLessThan(0.005); // per-step speed change < 5 mm/s (was a 0.9 m/s step at start/stop)
    expect(climbs).toBe(0);
    expect(deepest).toBeLessThanOrEqual(safe + 1e-6);
    expect(-sim.lars.position.y).toBeCloseTo(safe, 6);

    // --- Release: the tether takes over in AUTO, no spike, no jump.
    expect(sim.tms.mode).toBe('auto');
    expect(sim.releaseRov()).toBe(true);
    expect(sim.raiseAssembly()).toBe(false); // raise while released: refused

    // --- Excursion: fly away (forward and down) paying out tether.
    sim.command.surge = 0.8;
    sim.command.heave = -0.3;
    let maxTension = 0;
    let minSlack = Infinity;
    for (let i = 0; i < 30 * 120; i++) {
      step();
      maxTension = Math.max(maxTension, sim.tether.tension);
      if (i > 120) minSlack = Math.min(minSlack, sim.tether.slack);
    }
    Object.assign(sim.command, { surge: 0, heave: 0 });
    for (let i = 0; i < 10 * 120; i++) step();
    const farChord = sim.tether.chordLength;
    const farPayout = sim.tms.payout;
    expect(farChord).toBeGreaterThan(30);
    expect(farPayout).toBeGreaterThan(farChord);
    expect(maxTension).toBeLessThan(sim.tms.config.tensionWarn);
    expect(minSlack).toBeGreaterThan(1);

    // --- Return and dock: the winch hauls in (AUTO) while the pilot homes on the receptacle.
    let hauled = false;
    let docked = false;
    let captureAt = -1;
    for (let i = 0; i < 300 * 120 && sim.lars.state === 'released'; i++) {
      homingCommand(sim);
      const ev = step();
      if (sim.tms.speed < -0.5) hauled = true;
      if (ev.docked) {
        docked = true;
        captureAt = sim.rov.position.distanceTo(sim.lars.dockPosition(new Vector3()));
      }
    }
    Object.assign(sim.command, { surge: 0, sway: 0, heave: 0, yaw: 0 });
    expect(docked).toBe(true);
    expect(sim.lars.state).toBe('atDepth');
    expect(hauled).toBe(true);
    expect(sim.tms.payout).toBe(sim.tms.config.minLength);
    expect(sim.tether.enabled).toBe(false);
    expect(captureAt).toBeGreaterThan(0.05); // captured inside the envelope, not at the dock pose

    // --- Latch pull-in: smooth, rate-limited, converges to the dock pose.
    const pullStart = trace.maxStep.atDepth ?? 0;
    for (let i = 0; i < 8 * 120; i++) step();
    expect(sim.rov.position.distanceTo(sim.lars.dockPosition(new Vector3()))).toBeLessThan(1e-9);
    expect(Math.max(pullStart, trace.maxStep.atDepth)).toBeLessThan(0.006); // ≤ 6 mm per step (≈ 0.3 m/s + final snap ≤ 5 mm)

    // --- Recovery to deck.
    expect(sim.raiseAssembly()).toBe(true);
    expect(sim.releaseRov()).toBe(false); // release while raising: refused
    for (let i = 0; i < 400 * 120 && sim.lars.state === 'raising'; i++) step();
    expect(sim.lars.state).toBe('onDeck');
    expect(sim.rov.position.y).toBeGreaterThan(0);

    // --- Whole run: the exact state sequence and continuity.
    expect(trace.states).toEqual(['deck', 'lowering', 'atDepth', 'released', 'atDepth', 'raising', 'onDeck']);
    const worstStep = Math.max(...Object.values(trace.maxStep));
    const worstJerk = Math.max(...Object.values(trace.maxJerk));
    console.info(
      `[cycle] safe depth ${safe.toFixed(1)} m, excursion chord ${farChord.toFixed(1)} m / payout ${farPayout.toFixed(1)} m, ` +
        `max tension out ${maxTension.toFixed(0)} N, capture at ${captureAt.toFixed(2)} m from dock, ` +
        `max step ${(worstStep * 1000).toFixed(1)} mm, max Δstep ${(worstJerk * 1000).toFixed(2)} mm, ` +
        `per state ${JSON.stringify(Object.fromEntries(Object.entries(trace.maxStep).map(([k, v]) => [k, +(v * 1000).toFixed(1)])))} mm, ` +
        `Δstep per state ${JSON.stringify(Object.fromEntries(Object.entries(trace.maxJerk).map(([k, v]) => [k, +(v * 1000).toFixed(2)])))} mm`,
    );
    expect(worstStep).toBeLessThan(0.025); // < 3 m/s everywhere: no teleport
    expect(worstJerk).toBeLessThan(0.0015); // per-step velocity change < 0.18 m/s (no kick at release / capture / snap)
    // Riding the LARS: winch speed vertically plus the slow pendulum sway of the TMS (< 0.1 m/s).
    expect(trace.maxStep.lowering).toBeLessThanOrEqual((sim.lars.winchSpeed + 0.1) * DT);
    expect(trace.maxStep.raising).toBeLessThanOrEqual((sim.lars.winchSpeed + 0.1) * DT);
  }, 60_000);
});
