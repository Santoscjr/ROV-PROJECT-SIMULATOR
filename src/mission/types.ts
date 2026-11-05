import type { V3 } from '../sim/site';
import type { ConditionChoice } from '../sim/conditions';

/** Snapshot of simulation state consumed by a mission each frame. */
export interface MissionInput {
  dt: number;
  depth: number;
  altitude: number | null;
  position: V3;
  /** World velocity (m/s). */
  velocity: V3;
  /** Angular rate magnitude (deg/s). */
  angularRate: number;
  /** Heading (deg, 0 = north). Optional for backwards compatibility. */
  heading?: number;
  cameraPosition: V3;
  /** Unit view direction of the operational camera. */
  cameraDirection: V3;
  cameraMode: 'operational' | 'external';
  lightLevel: number;
  /** True if any movement command is being given. */
  commanding: boolean;
  /** Crane state reported by the simulator. */
  craneReleased: boolean;
  craneOnDeck: boolean;
  /** ROV latched under the Top-Hat at depth. */
  docked?: boolean;
  /** Launch & recovery state. */
  lars?: 'deck' | 'lowering' | 'atDepth' | 'released' | 'raising' | 'onDeck';
  /** TMS / tether state (from the simulation). */
  tms?: {
    mode: 'manual' | 'auto';
    command: 'pay' | 'haul' | 'stop';
    state: string;
    payout: number;
    speed: number;
    tension: number;
    slack: number;
    chord: number;
    tensionWarn: number;
    slackWarn: number;
  };
  /** Pilot assistance mode (for contextual hints). */
  pilotMode?: 'manual' | 'stabilize' | 'depthHold';
}

export interface Objective {
  key: string;
  params?: Record<string, string | number>;
}

export interface CollisionRecord {
  time: number;
  speed: number;
  kind: 'seabed' | 'structure';
}

export interface InspectionRecord {
  id: string;
  labelKey: string;
  time: number;
  range: number;
  offAxis: number;
}

/** A completed task of a task-based mission (training / adverse). */
export interface TaskRecord {
  id: string;
  labelKey: string;
  time: number;
  /** Seconds spent on the task. */
  duration: number;
}

/** A deviation from the operating procedure (reported, not punished arcade-style). */
export interface DeviationRecord {
  time: number;
  key: string;
  params?: Record<string, string | number>;
}

export interface MissionStats {
  startTime: number | null;
  endTime: number | null;
  maxDepth: number;
  distance: number;
  collisions: CollisionRecord[];
  inspections: InspectionRecord[];
  tasks: TaskRecord[];
  deviations: DeviationRecord[];
}

export const emptyStats = (): MissionStats => ({
  startTime: null,
  endTime: null,
  maxDepth: 0,
  distance: 0,
  collisions: [],
  inspections: [],
  tasks: [],
  deviations: [],
});

/** Visual marker the renderer draws for a mission (gates, targets). */
export interface MissionMarker {
  id: string;
  kind: 'gate' | 'target' | 'zone';
  position: V3;
  /** Gate ring radius / zone radius (m). */
  radius: number;
  /** Gate facing (unit vector) — optional. */
  normal?: V3;
  label: string;
  /** 'pending' | 'active' | 'done' — drives colour. */
  state: 'pending' | 'active' | 'done';
}

/** One entry of the progress bar shown in the HUD. */
export interface MissionStep {
  key: string;
  state: 'done' | 'active' | 'pending';
}

/** How the vehicle starts the operation. */
export type StartMode =
  /** On the crane: pre-dive checklist, launch, descent. */
  | 'crane'
  /** Already in the water, released, at a given position/heading. */
  | { position: V3; heading: number; lights: boolean };

/**
 * Common interface of every operation. The simulator, HUD and report only
 * talk to this interface.
 */
export interface OperationMission {
  readonly id: string;
  /** Overall flow: 'running' until completion. */
  readonly complete: boolean;
  stats: MissionStats;
  time: number;
  warning: Objective | null;
  /** Inspection hold progress or task hold progress 0..1, null if not applicable. */
  holdProgress(): number | null;
  /** Range / off-axis to the current camera target, null if not applicable. */
  targetGeometry(): { range: number; offAxis: number } | null;
  objective(): Objective;
  /** Short contextual tip for beginners (i18n key), or null. */
  hint(input: MissionInput | null): Objective | null;
  steps(): MissionStep[];
  /** Index (0-based) of the active step for "n/N" display. */
  stepIndex(): number;
  /** Label of the current stage (i18n key). */
  stageKey(): string;
  prepChecklist(): { lights: boolean; thrusters: boolean; camera: boolean } | null;
  navTarget(): V3 | null;
  navTargetLabel(): string | null;
  markers(): MissionMarker[];
  update(s: MissionInput): void;
  /** Pilot pressed "confirm". Returns a message key when something was recorded. */
  confirm(): Objective | null;
  notifyCameraToggled(): void;
  recordCollision(c: CollisionRecord): void;
  consumeLaunchRequest(): boolean;
  consumeRecoveryRequest(): boolean;
  /** Overall vehicle condition derived from impacts. */
  condition(): 'ok' | 'minor' | 'damage';
  /** Summary lines for the report: [labelKey, value text, status class]. */
  reportLines(): { labelKey: string; value: string; status?: 'ok' | 'warn' | 'alarm' }[];
}

export interface MissionDefinition {
  id: 'training' | 'inspection' | 'adverse' | 'tms' | 'free';
  titleKey: string;
  descKey: string;
  /** 1 = beginner … 3 = advanced */
  difficulty: 1 | 2 | 3;
  /** Conditions imposed by the mission (pilot cannot change them). */
  forcedConditions?: Partial<ConditionChoice>;
  start: StartMode;
  /** Initial TMS state (default: AUTO with working slack). */
  tms?: { mode: 'manual' | 'auto'; payout?: number; depth?: number };
  /** Default pilot mode suggested for this mission (pilot's setting wins if set explicitly). */
  create(): OperationMission;
}

export function conditionFromCollisions(collisions: CollisionRecord[]): 'ok' | 'minor' | 'damage' {
  const max = collisions.reduce((m, c) => Math.max(m, c.speed), 0);
  if (max >= 1.0) return 'damage';
  if (collisions.length > 0) return 'minor';
  return 'ok';
}
