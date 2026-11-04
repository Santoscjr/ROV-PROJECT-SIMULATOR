import {
  INSPECTION_POINTS,
  LAUNCH_POINT,
  PIPELINE_PATH,
  PLET,
  RECOVERY_DEPTH,
  RECOVERY_RADIUS,
  MANIFOLD,
  type V3,
} from '../sim/site';
import { terrainHeight } from '../sim/terrain';
import { Mission } from './mission';
import { TaskMission, type Task } from './taskMission';
import type { MissionDefinition } from './types';

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const above = (x: number, z: number, alt: number): V3 => v(x, terrainHeight(x, z) + alt, z);

/** Point along the pipeline (fraction 0..1 of the route) at `alt` m above the pipe. */
function alongPipeline(f: number, alt: number): V3 {
  const i = Math.min(PIPELINE_PATH.length - 1, Math.max(0, Math.round(f * (PIPELINE_PATH.length - 1))));
  const p = PIPELINE_PATH[i];
  return v(p.x, p.y + alt, p.z);
}

// --- Training field (north-east of the vessel, ~110–116 m water depth) ---------
/** Start ~8 m above the seabed so the pilot sees the bottom move under the vehicle. */
export const TRAINING_START = above(20, -16, 8);
const G1 = above(26, -34, 9);
const G2 = above(40, -40, 7);
const TP_BASE = above(46, -52, 0);
const TP_TARGET = v(TP_BASE.x, TP_BASE.y + 1.25, TP_BASE.z);

export function trainingTasks(): Task[] {
  return [
    { kind: 'translate', id: 'T1', labelKey: 'train.t1', axis: 'surge', distance: 8, headingTolerance: 20, hintKey: 'hint.train.surge' },
    { kind: 'translate', id: 'T2', labelKey: 'train.t2', axis: 'surge', distance: -4, headingTolerance: 20, hintKey: 'hint.train.back' },
    { kind: 'translate', id: 'T3', labelKey: 'train.t3', axis: 'sway', distance: 4, headingTolerance: 12, hintKey: 'hint.train.sway' },
    { kind: 'heading', id: 'T4', labelKey: 'train.t4', heading: 90, tolerance: 5, hold: 3, hintKey: 'hint.train.heading' },
    { kind: 'depth', id: 'T5', labelKey: 'train.t5', depth: Math.round(-TRAINING_START.y + 3), tolerance: 0.6, hold: 4, hintKey: 'hint.train.depth' },
    { kind: 'track', id: 'T6', labelKey: 'train.t6', heading: 90, tolerance: 6, distance: 12, hintKey: 'hint.train.track' },
    {
      kind: 'station',
      id: 'T7',
      labelKey: 'train.t7',
      point: null,
      radius: 1.5,
      depthTolerance: 0.6,
      maxSpeed: 0.12,
      maxRate: 3,
      hold: 6,
      hintKey: 'hint.train.station',
    },
    { kind: 'waypoint', id: 'G1', labelKey: 'train.g1', point: G1, radius: 2.5, hintKey: 'hint.train.gate' },
    { kind: 'waypoint', id: 'G2', labelKey: 'train.g2', point: G2, radius: 2.5, hintKey: 'hint.train.gate' },
    {
      kind: 'inspect',
      id: 'TP-1',
      labelKey: 'train.tp1',
      target: TP_TARGET,
      post: TP_BASE,
      minRange: 1.5,
      maxRange: 4,
      maxOffAxis: 15,
      hold: 5,
      hintKey: 'hint.train.inspect',
    },
  ];
}

// --- Adverse conditions route (along the export pipeline to the PLET) --------
export const ADVERSE_START = v(MANIFOLD.position.x + 2, -104, MANIFOLD.position.z + 9);

export function adverseTasks(): Task[] {
  const pletTarget = v(PLET.position.x - 0.2, PLET.position.y + 1.3, PLET.position.z);
  return [
    { kind: 'waypoint', id: 'W1', labelKey: 'adv.w1', point: alongPipeline(0.3, 4), radius: 3, hintKey: 'hint.adv.track' },
    { kind: 'waypoint', id: 'W2', labelKey: 'adv.w2', point: alongPipeline(0.55, 4), radius: 3, hintKey: 'hint.adv.track' },
    { kind: 'waypoint', id: 'W3', labelKey: 'adv.w3', point: alongPipeline(0.85, 4), radius: 3, hintKey: 'hint.adv.track' },
    {
      kind: 'station',
      id: 'S1',
      labelKey: 'adv.s1',
      point: v(PLET.position.x - 5, PLET.position.y + 3, PLET.position.z),
      radius: 1.2,
      depthTolerance: 0.6,
      maxSpeed: 0.15,
      maxRate: 4,
      hold: 15,
      hintKey: 'hint.adv.station',
    },
    {
      kind: 'inspect',
      id: 'IP-P',
      labelKey: 'adv.inspect',
      target: pletTarget,
      minRange: 1.5,
      maxRange: 4.5,
      maxOffAxis: 15,
      hold: 6,
      hintKey: 'hint.adv.inspect',
    },
    { kind: 'waypoint', id: 'W0', labelKey: 'adv.w0', point: alongPipeline(0.05, 6), radius: 3, hintKey: 'hint.adv.return' },
  ];
}

export const MISSIONS: MissionDefinition[] = [
  {
    id: 'training',
    titleKey: 'op.training.title',
    descKey: 'op.training.desc',
    difficulty: 1,
    forcedConditions: { current: 'low', visibility: 'clear' },
    start: { position: TRAINING_START, heading: 0, lights: true },
    create: () => new TaskMission({ id: 'training', tasks: trainingTasks(), stableSpeed: 0.15, stableRate: 4, minLightForRecord: 0.3 }),
  },
  {
    id: 'inspection',
    titleKey: 'op.inspection.title',
    descKey: 'op.inspection.desc',
    difficulty: 2,
    start: 'crane',
    create: () =>
      new Mission({
        workingDepth: 100,
        bottomAltitude: 12,
        locateRange: 25,
        stableSpeed: 0.15,
        stableRate: 4,
        recoveryPoint: { x: LAUNCH_POINT.x, y: 0, z: LAUNCH_POINT.z },
        recoveryRadius: RECOVERY_RADIUS,
        recoveryDepth: RECOVERY_DEPTH,
        points: INSPECTION_POINTS,
        approachSpeedLimit: 0.5,
        approachZone: 8,
        minLightForRecord: 0.4,
      }),
  },
  {
    id: 'adverse',
    titleKey: 'op.adverse.title',
    descKey: 'op.adverse.desc',
    difficulty: 3,
    forcedConditions: { current: 'strong', visibility: 'turbid', light: 'overcast' },
    start: { position: ADVERSE_START, heading: 100, lights: true },
    create: () => new TaskMission({ id: 'adverse', tasks: adverseTasks(), stableSpeed: 0.18, stableRate: 5, minLightForRecord: 0.4 }),
  },
];

export function missionById(id: string): MissionDefinition {
  return MISSIONS.find((m) => m.id === id) ?? MISSIONS[1];
}
