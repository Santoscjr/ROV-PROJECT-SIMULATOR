import type { InspectionPoint, V3 } from '../sim/site';

export type Stage = 'prep' | 'launch' | 'descent' | 'bottom' | 'inspection' | 'return' | 'recovery' | 'complete';
export const STAGES: Stage[] = ['prep', 'launch', 'descent', 'bottom', 'inspection', 'return', 'recovery', 'complete'];

export type InspectionPhase = 'locate' | 'approach' | 'aim' | 'hold' | 'confirm';

/** Snapshot of simulation state consumed by the mission each frame. */
export interface MissionInput {
  dt: number;
  depth: number;
  altitude: number | null;
  position: V3;
  /** World velocity (m/s). */
  velocity: V3;
  /** Angular rate magnitude (deg/s). */
  angularRate: number;
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
}

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
}

export interface Objective {
  key: string;
  params?: Record<string, string | number>;
}

export interface InspectionRecord {
  id: string;
  labelKey: string;
  time: number;
  range: number;
  offAxis: number;
}

export interface CollisionRecord {
  time: number;
  speed: number;
  kind: 'seabed' | 'structure';
}

export interface MissionStats {
  startTime: number | null;
  endTime: number | null;
  maxDepth: number;
  distance: number;
  collisions: CollisionRecord[];
  inspections: InspectionRecord[];
}

const DEG = 180 / Math.PI;

export class Mission {
  stage: Stage = 'prep';
  phase: InspectionPhase = 'locate';
  pointIndex = 0;
  /** Seconds of stable hold accumulated on the current point. */
  holdTime = 0;
  readonly checklist = { lights: false, thrusters: false, camera: false };
  readonly stats: MissionStats = { startTime: null, endTime: null, maxDepth: 0, distance: 0, collisions: [], inspections: [] };
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

  constructor(readonly config: MissionConfig) {}

  get currentPoint(): InspectionPoint | null {
    return this.stage === 'inspection' ? (this.config.points[this.pointIndex] ?? null) : null;
  }

  get checklistDone(): boolean {
    return this.checklist.lights && this.checklist.thrusters && this.checklist.camera;
  }

  /** Simulator polls these to drive the crane. */
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

  /** Where the navigation display should point. */
  navTarget(): V3 | null {
    if (this.stage === 'inspection') return this.currentPoint?.target ?? null;
    if (this.stage === 'descent' || this.stage === 'bottom') return this.config.points[0]?.target ?? null;
    if (this.stage === 'return' || this.stage === 'recovery') return this.config.recoveryPoint;
    return null;
  }

  /** The pilot switched cameras (pre-dive camera check). */
  notifyCameraToggled(): void {
    if (this.stage === 'prep') this.checklist.camera = true;
  }

  recordCollision(c: CollisionRecord): void {
    if (this.stage === 'prep' || this.stage === 'complete') return;
    this.stats.collisions.push(c);
  }

  /** Pilot pressed "confirm". Returns true if it was consumed. */
  confirm(): boolean {
    if (this.stage === 'prep' && this.checklistDone) {
      this.stage = 'launch';
      this.stats.startTime = this.time;
      this.launchRequested = true;
      return true;
    }
    if (this.stage === 'inspection' && this.phase === 'confirm') {
      const p = this.config.points[this.pointIndex];
      this.stats.inspections.push({ id: p.id, labelKey: p.labelKey, time: this.time, range: this.range, offAxis: this.offAxis });
      this.pointIndex++;
      this.holdTime = 0;
      this.phase = 'locate';
      if (this.pointIndex >= this.config.points.length) this.stage = 'return';
      return true;
    }
    return false;
  }

  update(s: MissionInput): void {
    this.time += s.dt;
    this.warning = null;

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
        if (s.lightLevel > 0) this.checklist.lights = true;
        if (s.commanding) this.checklist.thrusters = true;
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
        const r = this.config.recoveryPoint;
        const h = Math.hypot(s.position.x - r.x, s.position.z - r.z);
        if (h < this.config.recoveryRadius && s.depth < this.config.recoveryDepth) {
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

    if (this.phase === 'confirm') {
      // Keep the confirmation available while the framing is still acceptable.
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

    if (this.phase === 'hold') {
      if (s.cameraMode !== 'operational') {
        this.warning = { key: 'mission.cameraNeeded' };
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
        return { key: this.checklistDone ? 'mission.prep.launch' : 'mission.prep.waiting' };
      case 'launch':
        return { key: 'mission.launch' };
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
        return { key: 'mission.return', params: { depth: c.recoveryDepth, r: c.recoveryRadius } };
      case 'recovery':
        return { key: 'mission.recovery' };
      case 'complete':
        return { key: 'stage.complete' };
    }
    return { key: '' };
  }

  /** Overall vehicle condition derived from the impacts. */
  condition(): 'ok' | 'minor' | 'damage' {
    const max = this.stats.collisions.reduce((m, c) => Math.max(m, c.speed), 0);
    if (max >= 1.0) return 'damage';
    if (this.stats.collisions.length > 0) return 'minor';
    return 'ok';
  }
}
