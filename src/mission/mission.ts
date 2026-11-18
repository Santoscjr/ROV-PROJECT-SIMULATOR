import type { InspectionPoint, V3 } from '../sim/site';
import {
  conditionFromCollisions,
  emptyStats,
  type CollisionRecord,
  type MissionInput,
  type MissionMarker,
  type MissionStats,
  type MissionStep,
  type Objective,
  type OperationMission,
} from './types';

export type { MissionInput, Objective, CollisionRecord, MissionStats, InspectionRecord } from './types';

export type Stage = 'prep' | 'launch' | 'descent' | 'bottom' | 'inspection' | 'return' | 'recovery' | 'complete';
export const STAGES: Stage[] = ['prep', 'launch', 'descent', 'bottom', 'inspection', 'return', 'recovery', 'complete'];

export type InspectionPhase = 'locate' | 'approach' | 'aim' | 'hold' | 'confirm';

export interface MissionConfig {
  workingDepth: number;
  bottomAltitude: number;
  locateRange: number;
  stableSpeed: number;
  stableRate: number;
  recoveryPoint: V3;
  recoveryRadius: number;
  recoveryDepth: number;
  points: InspectionPoint[];
  /** Procedure: max speed when within `approachZone` m of the target (m/s). */
  approachSpeedLimit?: number;
  approachZone?: number;
  /** Procedure: minimum lamp level to record an inspection image (0..1). */
  minLightForRecord?: number;
}

const DEG = 180 / Math.PI;

/**
 * Offshore structure inspection: launch from the vessel, descent, approach to
 * the seabed, visual inspection of each point (range, framing and a stable
 * hold with adequate lighting, then confirmation), return and recovery.
 * Every objective depends on the simulated position/attitude/state.
 */
export class Mission implements OperationMission {
  readonly id: string = 'inspection';
  stage: Stage = 'prep';
  phase: InspectionPhase = 'locate';
  pointIndex = 0;
  /** Seconds of stable hold accumulated on the current point. */
  holdTime = 0;
  readonly checklistState = { lights: false, thrusters: false, camera: false };
  stats: MissionStats = emptyStats();
  /** Live geometry of the current inspection (for HUD). */
  range = Infinity;
  offAxis = 180;
  stable = false;
  warning: Objective | null = null;
  time = 0;
  private lastCameraMode: MissionInput['cameraMode'] | null = null;
  private lastPos: V3 | null = null;
  private launchRequested = false;
  private recoveryRequested = false;
  private lastSpeedDeviation = -100;
  private lightLevel = 0;
  private lars: MissionInput['lars'] = 'deck';

  constructor(readonly config: MissionConfig) {}

  /** Backwards-compatible accessor used by v1 code/tests. */
  get checklist(): { lights: boolean; thrusters: boolean; camera: boolean } {
    return this.checklistState;
  }

  get complete(): boolean {
    return this.stage === 'complete';
  }

  get currentPoint(): InspectionPoint | null {
    return this.stage === 'inspection' ? (this.config.points[this.pointIndex] ?? null) : null;
  }

  get checklistDone(): boolean {
    const c = this.checklistState;
    return c.lights && c.thrusters && c.camera;
  }

  consumeLaunchRequest(): boolean {
    const r = this.launchRequested;
    this.launchRequested = false;
    return r;
  }
  consumeRecoveryRequest(): boolean {
    const r = this.recoveryRequested;
    this.recoveryRequested = false;
    return r;
  }

  navTarget(): V3 | null {
    if (this.stage === 'inspection') return this.currentPoint?.target ?? null;
    if (this.stage === 'descent' || this.stage === 'bottom') return this.config.points[0]?.target ?? null;
    if (this.stage === 'return' || this.stage === 'recovery') return this.config.recoveryPoint;
    return null;
  }

  navTargetLabel(): string | null {
    const p = this.stage === 'inspection' ? this.currentPoint : this.stage === 'descent' || this.stage === 'bottom' ? this.config.points[0] : null;
    if (p) return p.id;
    if (this.stage === 'return' || this.stage === 'recovery') return 'LARS';
    return null;
  }

  markers(): MissionMarker[] {
    // Inspection targets are physical tags on the structures; only the
    // recovery zone is shown as a virtual marker during the return.
    if (this.stage !== 'return') return [];
    const r = this.config.recoveryPoint;
    return [{ id: 'recovery', kind: 'zone', position: { x: r.x, y: -this.config.recoveryDepth / 2, z: r.z }, radius: this.config.recoveryRadius, label: 'LARS', state: 'active' }];
  }

  notifyCameraToggled(): void {
    if (this.stage === 'prep') this.checklistState.camera = true;
  }

  recordCollision(c: CollisionRecord): void {
    if (this.stage === 'prep' || this.stage === 'complete') return;
    this.stats.collisions.push(c);
  }

  confirm(): Objective | null {
    // v3.2: the launch is never blocked by a checklist — the operational guide
    // only recommends the visual checks (they are recorded for the report).
    if (this.stage === 'prep') {
      if (!this.checklistDone) this.stats.deviations.push({ time: this.time, key: 'deviation.skippedChecks' });
      this.stage = 'launch';
      this.stats.startTime = this.time;
      this.launchRequested = true;
      return { key: 'msg.launchAuthorised' };
    }
    if (this.stage === 'inspection' && this.phase === 'confirm') {
      const p = this.config.points[this.pointIndex];
      this.stats.inspections.push({ id: p.id, labelKey: p.labelKey, time: this.time, range: this.range, offAxis: this.offAxis });
      this.pointIndex++;
      this.holdTime = 0;
      this.phase = 'locate';
      if (this.pointIndex >= this.config.points.length) this.stage = 'return';
      return { key: 'mission.recorded', params: { label: p.labelKey } };
    }
    return null;
  }

  update(s: MissionInput): void {
    this.time += s.dt;
    this.warning = null;
    this.lightLevel = s.lightLevel;
    this.lars = s.lars ?? this.lars;

    if (this.stage !== 'prep' && this.stage !== 'complete') {
      this.stats.maxDepth = Math.max(this.stats.maxDepth, s.depth);
      if (this.lastPos) {
        const d = Math.hypot(s.position.x - this.lastPos.x, s.position.y - this.lastPos.y, s.position.z - this.lastPos.z);
        if (d < 5) this.stats.distance += d;
      }
      this.lastPos = { ...s.position };
    }

    switch (this.stage) {
      case 'prep':
        if (s.lightLevel > 0) this.checklistState.lights = true;
        if (s.commanding) this.checklistState.thrusters = true;
        if (this.lastCameraMode !== null && s.cameraMode !== this.lastCameraMode) this.notifyCameraToggled();
        break;
      case 'launch':
        if (s.craneReleased) this.stage = 'descent';
        break;
      case 'descent':
        if (s.depth >= this.config.workingDepth || (s.altitude !== null && s.altitude < this.config.bottomAltitude * 1.6)) this.stage = 'bottom';
        break;
      case 'bottom':
        if (s.altitude !== null && s.altitude < this.config.bottomAltitude && Math.abs(s.velocity.y) < 0.3) {
          this.stage = 'inspection';
          this.phase = 'locate';
        }
        break;
      case 'inspection':
        this.updateInspection(s);
        break;
      case 'return': {
        // Recovery requires the ROV to be latched again under the Top-Hat.
        const docked = s.docked ?? false;
        if (docked) {
          this.stage = 'recovery';
          this.recoveryRequested = true;
        }
        break;
      }
      case 'recovery':
        if (s.craneOnDeck) {
          this.stage = 'complete';
          this.stats.endTime = this.time;
        }
        break;
      case 'complete':
        break;
    }
    this.lastCameraMode = s.cameraMode;
  }

  private updateInspection(s: MissionInput): void {
    const p = this.config.points[this.pointIndex];
    if (!p) return;
    const dx = p.target.x - s.cameraPosition.x;
    const dy = p.target.y - s.cameraPosition.y;
    const dz = p.target.z - s.cameraPosition.z;
    const range = Math.hypot(dx, dy, dz);
    this.range = range;
    const dot = range > 1e-6 ? (dx * s.cameraDirection.x + dy * s.cameraDirection.y + dz * s.cameraDirection.z) / range : 1;
    this.offAxis = Math.acos(Math.max(-1, Math.min(1, dot))) * DEG;
    const speed = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
    this.stable = speed < this.config.stableSpeed && s.angularRate < this.config.stableRate;

    // Procedure: slow approach near the structure.
    const zone = this.config.approachZone ?? 0;
    const limit = this.config.approachSpeedLimit ?? Infinity;
    if (range < zone && speed > limit) {
      this.warning = { key: 'mission.tooFast', params: { v: limit.toFixed(1) } };
      if (this.time - this.lastSpeedDeviation > 10) {
        this.lastSpeedDeviation = this.time;
        this.stats.deviations.push({ time: this.time, key: 'deviation.approachSpeed', params: { id: p.id, v: speed.toFixed(2) } });
      }
    }

    if (this.phase === 'confirm') {
      if (range > p.maxRange * 1.3 || this.offAxis > p.maxOffAxisDeg * 1.6) {
        this.phase = 'aim';
        this.holdTime = 0;
      }
      return;
    }

    const inRange = range >= p.minRange && range <= p.maxRange;
    const aimed = this.offAxis <= p.maxOffAxisDeg;
    if (range > this.config.locateRange) this.phase = 'locate';
    else if (!inRange) this.phase = 'approach';
    else if (!aimed) this.phase = 'aim';
    else this.phase = 'hold';

    const minLight = this.config.minLightForRecord ?? 0;
    if (this.phase === 'hold') {
      if (s.cameraMode !== 'operational') {
        this.warning = { key: 'mission.cameraNeeded' };
        this.holdTime = Math.max(0, this.holdTime - s.dt * 2);
      } else if (s.lightLevel < minLight) {
        this.warning = { key: 'mission.needLights', params: { v: Math.round(minLight * 100) } };
        this.holdTime = Math.max(0, this.holdTime - s.dt * 2);
      } else if (!this.stable) {
        this.warning = { key: 'mission.unstable' };
        this.holdTime = Math.max(0, this.holdTime - s.dt * 2);
      } else {
        this.holdTime += s.dt;
        if (this.holdTime >= p.holdSeconds) {
          this.holdTime = p.holdSeconds;
          this.phase = 'confirm';
        }
      }
    } else {
      this.holdTime = Math.max(0, this.holdTime - s.dt * 3);
      if (this.phase === 'approach' && range < p.minRange) this.warning = { key: 'mission.tooClose' };
    }
  }

  objective(): Objective {
    const c = this.config;
    switch (this.stage) {
      case 'prep':
        return { key: 'mission.prep.launch' };
      case 'launch':
        return { key: this.lars === 'atDepth' ? 'mission.launch.release' : 'mission.launch' };
      case 'descent':
        return { key: 'mission.descent', params: { depth: c.workingDepth } };
      case 'bottom':
        return { key: 'mission.bottom', params: { alt: c.bottomAltitude } };
      case 'inspection': {
        const p = c.points[this.pointIndex];
        const label = p.labelKey;
        switch (this.phase) {
          case 'locate':
            return { key: 'mission.locate', params: { label } };
          case 'approach':
            return { key: 'mission.approach', params: { label, min: p.minRange, max: p.maxRange } };
          case 'aim':
            return { key: 'mission.aim', params: { deg: p.maxOffAxisDeg } };
          case 'hold':
            return { key: 'mission.hold', params: { s: Math.max(0, p.holdSeconds - this.holdTime).toFixed(1) } };
          case 'confirm':
            return { key: 'mission.confirm' };
        }
        break;
      }
      case 'return':
        return { key: 'mission.return.tophat' };
      case 'recovery':
        return { key: 'mission.recovery' };
      case 'complete':
        return { key: 'stage.complete' };
    }
    return { key: '' };
  }

  hint(s: MissionInput | null): Objective | null {
    switch (this.stage) {
      case 'prep':
        return { key: 'hint.prep' };
      case 'launch':
        return { key: 'hint.launch' };
      case 'descent':
        return s?.pilotMode === 'depthHold' ? { key: 'hint.descentDH' } : { key: 'hint.descent' };
      case 'bottom':
        return { key: 'hint.bottom' };
      case 'inspection':
        if (this.phase === 'locate') return { key: 'hint.locate' };
        if (this.phase === 'approach') return { key: 'hint.approach' };
        if (this.phase === 'aim') return { key: 'hint.aim' };
        if (this.phase === 'hold') return { key: 'hint.hold' };
        return { key: 'hint.confirm' };
      case 'return':
        return { key: 'hint.return' };
      default:
        return null;
    }
  }

  holdProgress(): number | null {
    const p = this.currentPoint;
    return p && (this.phase === 'hold' || this.phase === 'confirm') ? this.holdTime / p.holdSeconds : null;
  }

  targetGeometry(): { range: number; offAxis: number } | null {
    return this.currentPoint ? { range: this.range, offAxis: this.offAxis } : null;
  }

  steps(): MissionStep[] {
    const si = STAGES.indexOf(this.stage);
    return STAGES.slice(0, -1).map((st, i) => ({ key: `stage.${st}`, state: i < si ? 'done' : i === si ? 'active' : 'pending' }));
  }

  stepIndex(): number {
    return Math.min(STAGES.indexOf(this.stage), STAGES.length - 2);
  }

  stageKey(): string {
    return `stage.${this.stage}`;
  }

  prepChecklist(): { lights: boolean; thrusters: boolean; camera: boolean } | null {
    return this.stage === 'prep' ? this.checklistState : null;
  }

  condition(): 'ok' | 'minor' | 'damage' {
    return conditionFromCollisions(this.stats.collisions);
  }

  reportLines(): { labelKey: string; value: string; status?: 'ok' | 'warn' | 'alarm' }[] {
    const total = this.config.points.length;
    const n = this.stats.inspections.length;
    return [
      {
        labelKey: 'report.inspections',
        value: this.stats.inspections.map((i) => `${i.id} · ${i.range.toFixed(1)} m · ${i.offAxis.toFixed(0)}°`).join('<br>') || '—',
        status: n >= total ? 'ok' : 'warn',
      },
    ];
  }

  /** Light level seen on the last update (for HUD/procedure display). */
  get lastLightLevel(): number {
    return this.lightLevel;
  }
}
