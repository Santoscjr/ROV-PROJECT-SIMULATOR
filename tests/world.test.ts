import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { terrainHeight } from '../src/sim/terrain';
import { COLLIDERS, FREE_SPAN, INSPECTION_POINTS, LAUNCH_POINT, MANIFOLD, PIPELINE_PATH, PIPELINE_RADIUS } from '../src/sim/site';
import { currentAt } from '../src/sim/ocean';
import { sphereBox, sphereCapsule } from '../src/physics/collision';
import { Simulation } from '../src/sim/simulation';

describe('site & environment', () => {
  it('has a working depth of about 120 m at the site and shallower water under the vessel', () => {
    expect(-MANIFOLD.position.y).toBeGreaterThan(115);
    expect(-MANIFOLD.position.y).toBeLessThan(125);
    expect(-terrainHeight(LAUNCH_POINT.x, LAUNCH_POINT.z)).toBeGreaterThan(100);
  });

  it('pipeline rests on the seabed except across the free span', () => {
    expect(FREE_SPAN.gap).toBeGreaterThan(0.5);
    let resting = 0;
    for (const p of PIPELINE_PATH) {
      const gap = p.y - PIPELINE_RADIUS - terrainHeight(p.x, p.z);
      expect(gap).toBeGreaterThan(-0.05);
      if (gap < 0.05) resting++;
    }
    expect(resting / PIPELINE_PATH.length).toBeGreaterThan(0.5);
  });

  it('inspection targets are reachable (approach position is not inside a collider)', () => {
    for (const ip of INSPECTION_POINTS) {
      const pos = new Vector3(ip.target.x + ip.approach.x * 3, ip.target.y + ip.approach.y * 3, ip.target.z + ip.approach.z * 3);
      expect(pos.y).toBeGreaterThan(terrainHeight(pos.x, pos.z) + 0.8);
      for (const c of COLLIDERS) {
        const hit = c.kind === 'box' ? sphereBox(pos, 0.6, c) : sphereCapsule(pos, 0.6, c);
        expect(hit).toBeNull();
      }
    }
  });

  it('current is weaker at depth and can be disabled', () => {
    const s = currentAt(5, 100, 0, 'normal');
    const d = currentAt(115, 5, 0, 'normal');
    expect(Math.hypot(s.x, s.z)).toBeGreaterThan(Math.hypot(d.x, d.z));
    expect(currentAt(50, 50, 0, 'off')).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('simulation (launch & recovery)', () => {
  it('lowers the ROV through the splash zone and releases it at depth', () => {
    const sim = new Simulation('stabilize');
    expect(sim.rov.position.y).toBeGreaterThan(0);
    sim.mission.checklist.lights = sim.mission.checklist.thrusters = sim.mission.checklist.camera = true;
    sim.mission.confirm();
    let splash = 0;
    for (let i = 0; i < 400 && sim.crane !== 'released'; i++) {
      const ev = sim.advance(0.1);
      if (ev.splash === 1) splash++;
      sim.updateMission(0.1, { cameraPosition: { x: 0, y: 0, z: 0 }, cameraDirection: { x: 1, y: 0, z: 0 }, cameraMode: 'external' });
    }
    expect(splash).toBe(1);
    expect(sim.crane).toBe('released');
    expect(sim.rov.kinematic).toBe(false);
    expect(sim.rov.depth).toBeGreaterThan(7);
    expect(sim.mission.stage).toBe('descent');
    // Heading is north after launch.
    expect(Math.min(sim.rov.heading, 360 - sim.rov.heading)).toBeLessThan(3);
  });

  it('runs physics at a fixed step independent of frame time', () => {
    const a = new Simulation('stabilize');
    const b = new Simulation('stabilize');
    for (const s of [a, b]) {
      s.crane = 'released';
      s.rov.kinematic = false;
      s.rov.position.set(0, -50, -40);
      s.command.surge = 0.6;
    }
    for (let i = 0; i < 300; i++) a.advance(1 / 60);
    for (let i = 0; i < 100; i++) b.advance(1 / 20);
    expect(a.rov.time).toBeCloseTo(b.rov.time, 1);
    expect(a.rov.position.distanceTo(b.rov.position)).toBeLessThan(0.05);
  });
});
