import { describe, expect, it } from 'vitest';
import { Mission, type MissionConfig, type MissionInput } from '../src/mission/mission';
import type { InspectionPoint } from '../src/sim/site';

const point: InspectionPoint = {
  id: 'IP-T',
  labelKey: 'x',
  target: { x: 0, y: -100, z: 0 },
  approach: { x: 1, y: 0, z: 0 },
  minRange: 1.5,
  maxRange: 5,
  maxOffAxisDeg: 15,
  holdSeconds: 2,
};

const config: MissionConfig = {
  workingDepth: 90,
  bottomAltitude: 10,
  locateRange: 25,
  stableSpeed: 0.15,
  stableRate: 4,
  recoveryPoint: { x: 50, y: 0, z: 0 },
  recoveryRadius: 6,
  recoveryDepth: 12,
  points: [point],
};

function input(over: Partial<MissionInput> = {}): MissionInput {
  return {
    dt: 0.1,
    depth: 0,
    altitude: null,
    position: { x: 50, y: 4, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    angularRate: 0,
    cameraPosition: { x: 3, y: -100, z: 0 },
    cameraDirection: { x: -1, y: 0, z: 0 },
    cameraMode: 'operational',
    lightLevel: 0,
    commanding: false,
    craneReleased: false,
    craneOnDeck: false,
    ...over,
  };
}

describe('mission flow', () => {
  it('requires the pre-dive checklist before launch', () => {
    const m = new Mission(config);
    expect(m.confirm()).toBe(false);
    m.update(input({ lightLevel: 0.8 }));
    m.update(input({ commanding: true }));
    m.notifyCameraToggled();
    expect(m.checklistDone).toBe(true);
    expect(m.confirm()).toBe(true);
    expect(m.stage).toBe('launch');
    expect(m.consumeLaunchRequest()).toBe(true);
  });

  function toInspection(): Mission {
    const m = new Mission(config);
    m.checklist.lights = m.checklist.thrusters = m.checklist.camera = true;
    m.confirm();
    m.update(input({ craneReleased: true, depth: 8 }));
    expect(m.stage).toBe('descent');
    m.update(input({ craneReleased: true, depth: 95, altitude: 25 }));
    expect(m.stage).toBe('bottom');
    m.update(input({ craneReleased: true, depth: 100, altitude: 8, velocity: { x: 0, y: -0.6, z: 0 } }));
    expect(m.stage).toBe('bottom'); // descending too fast
    m.update(input({ craneReleased: true, depth: 100, altitude: 8 }));
    expect(m.stage).toBe('inspection');
    return m;
  }

  it('progresses through descent and bottom approach based on depth/altitude', () => {
    toInspection();
  });

  it('inspection needs range, aim and a stable hold, then confirmation', () => {
    const m = toInspection();
    // Too far
    m.update(input({ cameraPosition: { x: 40, y: -100, z: 0 } }));
    expect(m.phase).toBe('locate');
    // In range but looking away
    m.update(input({ cameraDirection: { x: 0, y: 0, z: 1 } }));
    expect(m.phase).toBe('aim');
    // Aimed but moving → hold does not accumulate
    for (let i = 0; i < 30; i++) m.update(input({ velocity: { x: 0.4, y: 0, z: 0 } }));
    expect(m.phase).toBe('hold');
    expect(m.holdTime).toBe(0);
    expect(m.warning?.key).toBe('mission.unstable');
    // External camera does not count
    for (let i = 0; i < 30; i++) m.update(input({ cameraMode: 'external' }));
    expect(m.holdTime).toBe(0);
    // Stable hold
    for (let i = 0; i < 21; i++) m.update(input());
    expect(m.phase).toBe('confirm');
    expect(m.confirm()).toBe(true);
    expect(m.stats.inspections).toHaveLength(1);
    expect(m.stage).toBe('return');
  });

  it('recovery requires being shallow and under the crane', () => {
    const m = toInspection();
    for (let i = 0; i < 25; i++) m.update(input());
    m.confirm();
    m.update(input({ position: { x: 50, y: -40, z: 0 }, depth: 40 }));
    expect(m.stage).toBe('return');
    m.update(input({ position: { x: 70, y: -8, z: 0 }, depth: 8 }));
    expect(m.stage).toBe('return');
    m.update(input({ position: { x: 52, y: -8, z: 1 }, depth: 8 }));
    expect(m.stage).toBe('recovery');
    expect(m.consumeRecoveryRequest()).toBe(true);
    m.update(input({ craneOnDeck: true }));
    expect(m.stage).toBe('complete');
    expect(m.stats.endTime).not.toBeNull();
  });

  it('tracks collisions and derives the vehicle condition', () => {
    const m = toInspection();
    expect(m.condition()).toBe('ok');
    m.recordCollision({ time: 1, speed: 0.4, kind: 'seabed' });
    expect(m.condition()).toBe('minor');
    m.recordCollision({ time: 2, speed: 1.3, kind: 'structure' });
    expect(m.condition()).toBe('damage');
    expect(m.stats.collisions).toHaveLength(2);
  });

  it('records maximum depth and distance from real positions', () => {
    const m = toInspection();
    m.update(input({ depth: 118, position: { x: 0, y: -118, z: 0 } }));
    m.update(input({ depth: 117, position: { x: 1, y: -117.5, z: 1.5 } }));
    expect(m.stats.maxDepth).toBe(118);
    expect(m.stats.distance).toBeGreaterThanOrEqual(1.8);
  });
});
