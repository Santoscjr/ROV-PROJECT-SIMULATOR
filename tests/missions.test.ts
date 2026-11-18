import { describe, expect, it } from 'vitest';
import { TaskMission, type Task } from '../src/mission/taskMission';
import { MISSIONS, missionById, trainingTasks, adverseTasks, TRAINING_START, ADVERSE_START } from '../src/mission/catalog';
import type { MissionInput } from '../src/mission/types';
import { resolveConditions, visibilityRange, DEFAULT_CONDITIONS } from '../src/sim/conditions';
import { currentAt } from '../src/sim/ocean';
import { Simulation, safeTmsDepth, TMS_MIN_ALTITUDE, TMS_MIN_DEPTH } from '../src/sim/simulation';
import { TOPHAT } from '../src/sim/topHat';
import { terrainHeight } from '../src/sim/terrain';
import { COLLIDERS, LAUNCH_POINT } from '../src/sim/site';
import { sphereBox, sphereCapsule } from '../src/physics/collision';
import { Vector3 } from 'three';

function input(over: Partial<MissionInput> = {}): MissionInput {
  return {
    dt: 0.1,
    depth: 90,
    altitude: 20,
    position: { x: 0, y: -90, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    angularRate: 0,
    heading: 0,
    cameraPosition: { x: 0, y: -90, z: 0 },
    cameraDirection: { x: 0, y: 0, z: -1 },
    cameraMode: 'operational',
    lightLevel: 0.8,
    commanding: false,
    craneReleased: true,
    craneOnDeck: false,
    ...over,
  };
}

const mk = (tasks: Task[]) => new TaskMission({ id: 't', tasks, stableSpeed: 0.15, stableRate: 4, minLightForRecord: 0.3 });

describe('task mission engine', () => {
  it('translate: counts displacement in the vehicle frame captured at task start', () => {
    const m = mk([{ kind: 'translate', id: 'a', labelKey: 'x', axis: 'sway', distance: 4, headingTolerance: 10 }]);
    // Heading east (090): starboard is south (+Z).
    m.update(input({ heading: 90 }));
    m.update(input({ heading: 90, position: { x: 4, y: -90, z: 0 } })); // moved forward, not sideways
    expect(m.complete).toBe(false);
    m.update(input({ heading: 90, position: { x: 4, y: -90, z: 4.1 } }));
    expect(m.complete).toBe(true);
  });

  it('translate: rejects completion while the heading tolerance is violated', () => {
    const m = mk([{ kind: 'translate', id: 'a', labelKey: 'x', axis: 'surge', distance: 5, headingTolerance: 10 }]);
    m.update(input({ heading: 0 }));
    m.update(input({ heading: 40, position: { x: 0, y: -90, z: -6 } }));
    expect(m.complete).toBe(false);
    expect(m.warning?.key).toBe('task.keepHeading');
    m.update(input({ heading: 2, position: { x: 0, y: -90, z: -6 } }));
    expect(m.complete).toBe(true);
  });

  it('heading and depth require holding within tolerance for the set time', () => {
    const m = mk([
      { kind: 'heading', id: 'h', labelKey: 'x', heading: 90, tolerance: 5, hold: 1 },
      { kind: 'depth', id: 'd', labelKey: 'x', depth: 100, tolerance: 0.5, hold: 1 },
    ]);
    for (let i = 0; i < 20; i++) m.update(input({ heading: 70 }));
    expect(m.index).toBe(0);
    for (let i = 0; i < 11; i++) m.update(input({ heading: 92 }));
    expect(m.index).toBe(1);
    for (let i = 0; i < 11; i++) m.update(input({ depth: 100.2, velocity: { x: 0, y: -0.5, z: 0 } })); // still moving
    expect(m.index).toBe(1);
    for (let i = 0; i < 11; i++) m.update(input({ depth: 100.2 }));
    expect(m.complete).toBe(true);
  });

  it('track only counts distance covered on heading', () => {
    const m = mk([{ kind: 'track', id: 'k', labelKey: 'x', heading: 90, tolerance: 5, distance: 3 }]);
    m.update(input({ heading: 90 }));
    m.update(input({ heading: 130, position: { x: 2, y: -90, z: 0 } })); // off heading: not counted
    m.update(input({ heading: 90, position: { x: 3.5, y: -90, z: 0 } }));
    expect(m.complete).toBe(false);
    m.update(input({ heading: 90, position: { x: 5.2, y: -90, z: 0 } }));
    expect(m.complete).toBe(true);
  });

  it('station keeping requires staying in the zone and calm', () => {
    const m = mk([{ kind: 'station', id: 's', labelKey: 'x', point: { x: 0, y: -90, z: 0 }, radius: 1, depthTolerance: 0.5, maxSpeed: 0.1, maxRate: 3, hold: 1 }]);
    for (let i = 0; i < 15; i++) m.update(input({ position: { x: 2, y: -90, z: 0 } }));
    expect(m.complete).toBe(false);
    for (let i = 0; i < 15; i++) m.update(input({ velocity: { x: 0.3, y: 0, z: 0 } }));
    expect(m.complete).toBe(false);
    for (let i = 0; i < 11; i++) m.update(input());
    expect(m.complete).toBe(true);
  });

  it('inspect requires framing, operational camera, lights and confirmation', () => {
    const m = mk([{ kind: 'inspect', id: 'i', labelKey: 'x', target: { x: 0, y: -90, z: -3 }, minRange: 1.5, maxRange: 4, maxOffAxis: 15, hold: 1 }]);
    for (let i = 0; i < 15; i++) m.update(input({ lightLevel: 0 }));
    expect(m.warning?.key).toBe('mission.needLights');
    for (let i = 0; i < 15; i++) m.update(input({ cameraMode: 'external' }));
    expect(m.confirm()).toBeNull();
    for (let i = 0; i < 11; i++) m.update(input());
    expect(m.objective().key).toBe('mission.confirm');
    expect(m.confirm()).not.toBeNull();
    expect(m.complete).toBe(true);
    expect(m.stats.inspections).toHaveLength(1);
  });

  it('waypoints complete inside the radius and expose markers/nav targets', () => {
    const m = mk([{ kind: 'waypoint', id: 'G', labelKey: 'x', point: { x: 10, y: -90, z: 0 }, radius: 2 }]);
    expect(m.markers()[0].kind).toBe('gate');
    m.update(input());
    expect(m.navTarget()).toEqual({ x: 10, y: -90, z: 0 });
    m.update(input({ position: { x: 8.5, y: -90, z: 0.5 } }));
    expect(m.complete).toBe(true);
    expect(m.stats.tasks).toHaveLength(1);
  });
});

describe('mission catalog', () => {
  it('provides training, inspection and adverse operations', () => {
    expect(MISSIONS.map((m) => m.id)).toEqual(['training', 'inspection', 'adverse', 'tms', 'free']);
    expect(missionById('nope').id).toBe('inspection');
  });

  it('places waypoints and start points in open water (not in the seabed or structures)', () => {
    const pts = [...trainingTasks(), ...adverseTasks()].flatMap((t) => (t.kind === 'waypoint' ? [t.point] : t.kind === 'station' && t.point ? [t.point] : []));
    for (const def of MISSIONS) if (def.start !== 'crane') pts.push(def.start.position);
    for (const p of pts) {
      expect(p.y).toBeGreaterThan(terrainHeight(p.x, p.z) + 1.5);
      const v = new Vector3(p.x, p.y, p.z);
      for (const c of COLLIDERS) expect(c.kind === 'box' ? sphereBox(v, 1.2, c) : sphereCapsule(v, 1.2, c)).toBeNull();
    }
  });

  it('training/adverse start released at their site position with the tether paid out (v3.1.1)', () => {
    const sim = new Simulation('stabilize', 'training');
    expect(sim.crane).toBe('released');
    expect(sim.rov.kinematic).toBe(false);
    expect(sim.lightsOn).toBe(true);
    expect(sim.rov.position.distanceTo(new Vector3(TRAINING_START.x, TRAINING_START.y, TRAINING_START.z))).toBeLessThan(0.01);
    expect(Math.min(sim.rov.heading, 360 - sim.rov.heading)).toBeLessThan(1);
    // Tether covers the straight distance to the Top-Hat plus working slack.
    expect(sim.tms.payout).toBeGreaterThan(sim.tmsExit.distanceTo(sim.rov.position));
    // T5 (depth task) is relative to the real start depth again: 3 m below it.
    const t5 = trainingTasks().find((t) => t.id === 'T5') as { depth: number };
    expect(t5.depth - sim.rov.depth).toBeCloseTo(3, 0);
    // Stable: a few seconds without commands keep the vehicle near its start, tether taut-free.
    for (let i = 0; i < 40; i++) sim.advance(0.25);
    expect(sim.rov.position.distanceTo(new Vector3(TRAINING_START.x, TRAINING_START.y, TRAINING_START.z))).toBeLessThan(3);
    expect(sim.tether.tension).toBeLessThan(sim.tms.config.tensionWarn);
    sim.reset('stabilize', missionById('adverse'));
    expect(sim.crane).toBe('released');
    expect(Math.abs(sim.rov.heading - 100)).toBeLessThan(1);
    expect(sim.rov.position.distanceTo(new Vector3(ADVERSE_START.x, ADVERSE_START.y, ADVERSE_START.z))).toBeLessThan(0.01);
  });

  it('TMS training and free mode start latched under the Top-Hat at the operator depth', () => {
    const sim = new Simulation('stabilize', 'free');
    sim.tmsDepth = 50;
    sim.reset('stabilize', missionById('free'));
    expect(sim.crane).toBe('docked');
    expect(-sim.lars.position.y).toBeCloseTo(50, 3);
    sim.reset('stabilize', missionById('tms'));
    expect(sim.crane).toBe('docked');
    expect(-sim.lars.position.y).toBeCloseTo(50, 3);
    expect(sim.releaseRov()).toBe(true);
  });

  it('Top-Hat depth never takes the latched ROV into (or too close to) the seabed', () => {
    const seabed = -terrainHeight(LAUNCH_POINT.x, LAUNCH_POINT.z);
    expect(safeTmsDepth(50)).toBe(50);
    const deepest = safeTmsDepth(10_000);
    expect(deepest).toBeLessThan(seabed);
    expect(seabed - (deepest + TOPHAT.dockDrop + 1)).toBeGreaterThanOrEqual(TMS_MIN_ALTITUDE - 1e-9);
    expect(safeTmsDepth(-5)).toBe(TMS_MIN_DEPTH);
    // Shallow seabed: still never below it.
    expect(safeTmsDepth(100, 40)).toBeLessThanOrEqual(40 - TMS_MIN_ALTITUDE - TOPHAT.dockDrop - 1 + 1e-9);
    // Real lowering with an absurd setting stops above the seabed (no indefinite descent).
    const sim = new Simulation('stabilize', 'inspection');
    sim.tmsDepth = 500;
    sim.reset('stabilize', missionById('inspection'));
    sim.lars.startLowering();
    for (let i = 0; i < 2400; i++) sim.advance(0.25);
    expect(sim.lars.state).toBe('atDepth');
    const rovBottom = -sim.rov.position.y + 1;
    expect(rovBottom).toBeLessThan(seabed - TMS_MIN_ALTITUDE + 0.5);
  });

  it('free mode: O recovers the latched assembly to the deck and lowers it again', () => {
    const sim = new Simulation('stabilize', 'free');
    sim.reset('stabilize', missionById('free'));
    expect(sim.toggleAssembly()).toBe('raising');
    for (let i = 0; i < 1200 && sim.lars.state !== 'onDeck'; i++) sim.advance(0.25);
    expect(sim.lars.state).toBe('onDeck');
    expect(sim.toggleAssembly()).toBe('lowering');
    // Released ROV must dock first.
    sim.reset('stabilize', missionById('free'));
    sim.releaseRov();
    expect(sim.toggleAssembly()).toBeNull();
  });

  it('missions impose their conditions over the pilot choice', () => {
    const sim = new Simulation('stabilize', 'inspection');
    sim.setConditionChoice({ current: 'off', visibility: 'clear', light: 'night', sea: 'calm' });
    expect(sim.conditions.current.speedScale).toBe(0);
    sim.reset('stabilize', missionById('adverse'));
    expect(sim.conditions.choice.current).toBe('strong');
    expect(sim.conditions.choice.visibility).toBe('turbid');
    expect(sim.conditions.choice.sea).toBe('calm'); // not forced → pilot's choice
  });
});

describe('environmental conditions', () => {
  it('stronger current produces larger hydrodynamic drift on the vehicle', () => {
    const drift = (level: 'low' | 'strong') => {
      const sim = new Simulation('manual', 'inspection'); // inspection does not force conditions
      sim.setConditionChoice({ ...DEFAULT_CONDITIONS, current: level });
      sim.crane = 'released';
      sim.tms.reset(300, 'manual'); // plenty of slack: measure the current, not the tether
      sim.rov.position.set(20, -90, -16);
      const p0 = sim.rov.position.clone();
      for (let i = 0; i < 60; i++) sim.advance(0.25);
      return Math.hypot(sim.rov.position.x - p0.x, sim.rov.position.z - p0.z);
    };
    expect(drift('strong')).toBeGreaterThan(drift('low') * 2);
  });

  it('turbid water reduces visibility; current scale follows the preset', () => {
    const clear = resolveConditions({ ...DEFAULT_CONDITIONS, visibility: 'clear' });
    const turbid = resolveConditions({ ...DEFAULT_CONDITIONS, visibility: 'turbid' });
    expect(visibilityRange(turbid)).toBeLessThan(visibilityRange(clear) / 2);
    const s = (lvl: 'low' | 'normal' | 'strong') => {
      const c = currentAt(110, 6, 0, resolveConditions({ ...DEFAULT_CONDITIONS, current: lvl }).current);
      return Math.hypot(c.x, c.z);
    };
    expect(s('strong')).toBeGreaterThan(s('normal'));
    expect(s('normal')).toBeGreaterThan(s('low'));
  });

  it('night removes almost all surface light', () => {
    expect(resolveConditions({ ...DEFAULT_CONDITIONS, light: 'night' }).light.surfaceIrradiance).toBeLessThan(0.01);
  });
});
