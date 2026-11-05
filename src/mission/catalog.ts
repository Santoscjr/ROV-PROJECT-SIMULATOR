import {
  INSPECTION_POINTS,
  LAUNCH_POINT,
  PIPELINE_PATH,
  PLET,
  RECOVERY_DEPTH,
  RECOVERY_RADIUS,
  MANIFOLD,
  TMS,
  type V3,
} from '../sim/site';
import { terrainHeight } from '../sim/terrain';
import { Mission } from './mission';
import { TaskMission, type Task } from './taskMission';
import type { MissionDefinition, MissionInput, Objective } from './types';

/** Free piloting: no objectives, no timer, never completes (end it from the pause menu). */
class FreeMission extends TaskMission {
  override get complete(): boolean {
    return false;
  }
  override objective(): Objective {
    return { key: 'free.objective' };
  }
  override hint(): Objective | null {
    return { key: 'hint.free' };
  }
  override stageKey(): string {
    return 'op.free.title';
  }
  /** No tasks: only keep time/statistics (the base class expects a current task). */
  override update(s: MissionInput): void {
    this.time += s.dt;
    this.warning = null;
    if (this.stats.startTime === null) this.stats.startTime = this.time;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, s.depth);
  }
  override holdProgress(): number | null {
    return null;
  }
}

// --- TMS training: start just below the TMS -------------------------------------
export const TMS_START: V3 = { x: TMS.exit.x, y: TMS.exit.y - 5, z: TMS.exit.z + 2 };

const tmsOf = (s: MissionInput) => s.tms!;
export function tmsTrainingTasks(): Task[] {
  return [
    { kind: 'check', id: 'M1', labelKey: 'tmsTrain.prep', hold: 0.3, test: (s) => tmsOf(s).mode === 'manual', hintKey: 'hint.tms.prep' },
    { kind: 'check', id: 'M2', labelKey: 'tmsTrain.pay', hold: 0.3, test: (s) => tmsOf(s).payout >= 25, params: (s) => ({ v: s ? tmsOf(s).payout.toFixed(1) : '0' }), hintKey: 'hint.tms.pay' },
    { kind: 'check', id: 'M3', labelKey: 'tmsTrain.away', hold: 0.5, test: (s) => tmsOf(s).chord >= 18, params: (s) => ({ v: s ? tmsOf(s).chord.toFixed(1) : '0' }), hintKey: 'hint.tms.away' },
    {
      kind: 'check',
      id: 'M4',
      labelKey: 'tmsTrain.slack',
      hold: 10,
      test: (s) => tmsOf(s).slack >= 2 && tmsOf(s).slack <= 15 && tmsOf(s).tension < tmsOf(s).tensionWarn,
      params: (s) => ({ v: s ? tmsOf(s).slack.toFixed(1) : '0' }),
      hintKey: 'hint.tms.slack',
    },
    { kind: 'check', id: 'M5', labelKey: 'tmsTrain.approach', hold: 0.5, test: (s) => tmsOf(s).chord <= 6, params: (s) => ({ v: s ? tmsOf(s).chord.toFixed(1) : '0' }), hintKey: 'hint.tms.approach' },
    {
      kind: 'check',
      id: 'M6',
      labelKey: 'tmsTrain.haul',
      hold: 0.5,
      test: (s) => tmsOf(s).payout <= 10 && tmsOf(s).slack < 8,
      params: (s) => ({ v: s ? tmsOf(s).payout.toFixed(1) : '0' }),
      hintKey: 'hint.tms.haul',
    },
    {
      kind: 'check',
      id: 'M7',
      labelKey: 'tmsTrain.finish',
      hold: 0.5,
      test: (s) => s.docked === true,
      hintKey: 'hint.tms.finish',
    },
  ];
}

/** Evaluation of tether handling (events recorded in the report). */
function tmsMonitor(s: MissionInput, m: TaskMission): void {
  const t = s.tms;
  if (!t) return;
  const speed = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
  if (t.tension > t.tensionWarn) m.deviation('dev.tms.tension', { v: (t.tension / 1000).toFixed(1) }, 8);
  if (t.slack > t.slackWarn) m.deviation('dev.tms.slack', { v: t.slack.toFixed(0) }, 10);
  if (t.chord < 3 && speed > 0.3) m.deviation('dev.tms.approach', { v: speed.toFixed(2) }, 8);
  if (t.command === 'haul' && t.tension > t.tensionWarn) m.deviation('dev.tms.haulTension', undefined, 8);
  if (t.command === 'pay' && t.slack > t.slackWarn) m.deviation('dev.tms.paySlack', undefined, 8);
}

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
    start: { position: TRAINING_START, heading: 0, lights: true, released: true },
    tms: { mode: 'auto' },
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
        recoveryPoint: { x: LAUNCH_POINT.x, y: -80, z: LAUNCH_POINT.z },
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
    start: { position: ADVERSE_START, heading: 100, lights: true, released: true },
    tms: { mode: 'auto' },
    create: () => new TaskMission({ id: 'adverse', tasks: adverseTasks(), stableSpeed: 0.18, stableRate: 5, minLightForRecord: 0.4 }),
  },
];

MISSIONS.push(
  {
    id: 'tms',
    titleKey: 'op.tms.title',
    descKey: 'op.tms.desc',
    difficulty: 2,
    forcedConditions: { current: 'low', visibility: 'clear' },
    start: { position: TMS_START, heading: 0, lights: true },
    tms: { mode: 'auto' },
    create: () => new TaskMission({ id: 'tms', tasks: tmsTrainingTasks(), stableSpeed: 0.15, stableRate: 4, minLightForRecord: 0, monitor: tmsMonitor }),
  },
  {
    id: 'free',
    titleKey: 'op.free.title',
    descKey: 'op.free.desc',
    difficulty: 1,
    start: { position: TMS_START, heading: 0, lights: true },
    tms: { mode: 'auto' },
    create: () => new FreeMission({ id: 'free', tasks: [], stableSpeed: 0.15, stableRate: 4, minLightForRecord: 0 }),
  },
);

export function missionById(id: string): MissionDefinition {
  return MISSIONS.find((m) => m.id === id) ?? MISSIONS[1];
}
