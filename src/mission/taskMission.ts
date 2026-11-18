import type { V3 } from '../sim/site';
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

const DEG = 180 / Math.PI;

/** Shortest signed difference a − b in degrees. */
function angDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export type Task =
  | {
      kind: 'translate';
      id: string;
      labelKey: string;
      /** Body axis of the vehicle at task start. */
      axis: 'surge' | 'sway' | 'heave';
      /** Signed displacement required (m). */
      distance: number;
      /** Max heading deviation allowed (deg) — counted only while respected. */
      headingTolerance?: number;
      hintKey?: string;
    }
  | { kind: 'heading'; id: string; labelKey: string; heading: number; tolerance: number; hold: number; hintKey?: string }
  | { kind: 'depth'; id: string; labelKey: string; depth: number; tolerance: number; hold: number; hintKey?: string }
  | {
      kind: 'track';
      id: string;
      labelKey: string;
      heading: number;
      tolerance: number;
      /** Distance to cover over ground while on heading (m). */
      distance: number;
      hintKey?: string;
    }
  | {
      kind: 'station';
      id: string;
      labelKey: string;
      /** Point to hold; null = where the task starts. */
      point: V3 | null;
      radius: number;
      depthTolerance: number;
      maxSpeed: number;
      maxRate: number;
      hold: number;
      hintKey?: string;
    }
  | { kind: 'waypoint'; id: string; labelKey: string; point: V3; radius: number; gate?: V3; hintKey?: string }
  | CheckTask
  | {
      kind: 'inspect';
      id: string;
      labelKey: string;
      target: V3;
      minRange: number;
      maxRange: number;
      maxOffAxis: number;
      hold: number;
      /** Marker post base position for the renderer. */
      post?: V3;
      hintKey?: string;
    };

export type CheckTask = {
  kind: 'check';
  id: string;
  labelKey: string;
  /** Condition on the simulated state; must hold continuously for `hold` s. */
  test: (s: MissionInput) => boolean;
  hold: number;
  /** Objective params shown while active. */
  params?: (s: MissionInput | null) => Record<string, string | number>;
  hintKey?: string;
};

export interface TaskMissionConfig {
  id: string;
  tasks: Task[];
  stableSpeed: number;
  stableRate: number;
  /** Minimum lamp level for inspect tasks (0..1). */
  minLightForRecord: number;
  /** Optional evaluation hook called every update (record deviations/events). */
  monitor?: (s: MissionInput, m: TaskMission) => void;
}

interface TaskState {
  startPos: V3;
  startHeading: number;
  startTime: number;
  progress: number;
  holdTime: number;
  covered: number;
  lastPos: V3;
  ready: boolean;
}

/**
 * Sequential, verifiable training/operation tasks. Each task is evaluated
 * against the simulated state (position in the vehicle's frame, heading,
 * depth, rates, camera framing) — never on timers alone.
 */
export class TaskMission implements OperationMission {
  readonly id: string;
  index = 0;
  stats: MissionStats = emptyStats();
  time = 0;
  warning: Objective | null = null;
  private st: TaskState | null = null;
  private range = Infinity;
  private offAxis = 180;
  private lastPos: V3 | null = null;
  private started = false;
  private lastInput: MissionInput | null = null;
  private readonly lastEvent = new Map<string, number>();

  /** Record a procedure deviation at most once per `every` seconds per key. */
  deviation(key: string, params?: Record<string, string | number>, every = 10): void {
    const last = this.lastEvent.get(key) ?? -1e9;
    if (this.time - last < every) return;
    this.lastEvent.set(key, this.time);
    this.stats.deviations.push({ time: this.time, key, params });
  }

  constructor(readonly config: TaskMissionConfig) {
    this.id = config.id;
  }

  get complete(): boolean {
    return this.index >= this.config.tasks.length;
  }

  get current(): Task | null {
    return this.config.tasks[this.index] ?? null;
  }

  private begin(s: MissionInput): void {
    this.st = {
      startPos: { ...s.position },
      startHeading: s.heading ?? 0,
      startTime: this.time,
      progress: 0,
      holdTime: 0,
      covered: 0,
      lastPos: { ...s.position },
      ready: false,
    };
  }

  private finishTask(): void {
    const t = this.current!;
    this.stats.tasks.push({ id: t.id, labelKey: t.labelKey, time: this.time, duration: this.time - (this.st?.startTime ?? this.time) });
    this.index++;
    this.st = null;
    if (this.complete) this.stats.endTime = this.time;
  }

  update(s: MissionInput): void {
    this.time += s.dt;
    this.warning = null;
    if (!this.started) {
      this.started = true;
      this.stats.startTime = this.time;
    }
    if (this.complete) return;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, s.depth);
    if (this.lastPos) {
      const d = Math.hypot(s.position.x - this.lastPos.x, s.position.y - this.lastPos.y, s.position.z - this.lastPos.z);
      if (d < 5) this.stats.distance += d;
    }
    this.lastPos = { ...s.position };

    const t = this.current!;
    if (!this.st) this.begin(s);
    const st = this.st!;
    const heading = s.heading ?? 0;
    const speed = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
    const stable = speed < this.config.stableSpeed && s.angularRate < this.config.stableRate;
    const vz = s.velocity.y;

    this.lastInput = s;
    this.config.monitor?.(s, this);
    switch (t.kind) {
      case 'check': {
        if (t.test(s)) st.holdTime += s.dt;
        else st.holdTime = 0;
        st.progress = t.hold > 0 ? Math.min(1, st.holdTime / t.hold) : 1;
        if (st.holdTime >= t.hold) this.finishTask();
        break;
      }
      case 'translate': {
        // Displacement expressed in the vehicle frame captured at task start.
        const h = st.startHeading / DEG;
        const fwd = { x: Math.sin(h), z: -Math.cos(h) };
        const right = { x: Math.cos(h), z: Math.sin(h) };
        const dx = s.position.x - st.startPos.x;
        const dz = s.position.z - st.startPos.z;
        const disp = t.axis === 'surge' ? dx * fwd.x + dz * fwd.z : t.axis === 'sway' ? dx * right.x + dz * right.z : s.position.y - st.startPos.y;
        const tol = t.headingTolerance ?? 180;
        if (Math.abs(angDiff(heading, st.startHeading)) > tol) {
          this.warning = { key: 'task.keepHeading', params: { h: Math.round(((st.startHeading % 360) + 360) % 360) } };
        }
        st.progress = Math.max(0, Math.min(1, disp / t.distance));
        if (st.progress >= 1 && Math.abs(angDiff(heading, st.startHeading)) <= tol) this.finishTask();
        break;
      }
      case 'heading': {
        const err = Math.abs(angDiff(heading, t.heading));
        if (err <= t.tolerance && s.angularRate < 4) st.holdTime += s.dt;
        else st.holdTime = Math.max(0, st.holdTime - s.dt * 2);
        st.progress = st.holdTime / t.hold;
        if (st.holdTime >= t.hold) this.finishTask();
        break;
      }
      case 'depth': {
        const err = Math.abs(s.depth - t.depth);
        if (err <= t.tolerance && Math.abs(vz) < 0.12) st.holdTime += s.dt;
        else st.holdTime = Math.max(0, st.holdTime - s.dt * 2);
        st.progress = st.holdTime / t.hold;
        if (st.holdTime >= t.hold) this.finishTask();
        break;
      }
      case 'track': {
        const step = Math.hypot(s.position.x - st.lastPos.x, s.position.z - st.lastPos.z);
        const onHeading = Math.abs(angDiff(heading, t.heading)) <= t.tolerance;
        if (onHeading && step < 2) st.covered += step;
        else if (!onHeading) this.warning = { key: 'task.keepHeading', params: { h: t.heading } };
        st.lastPos = { ...s.position };
        st.progress = Math.min(1, st.covered / t.distance);
        if (st.covered >= t.distance) this.finishTask();
        break;
      }
      case 'station': {
        const p = t.point ?? st.startPos;
        const horiz = Math.hypot(s.position.x - p.x, s.position.z - p.z);
        const dDepth = Math.abs(s.position.y - p.y);
        const inside = horiz <= t.radius && dDepth <= t.depthTolerance;
        const calm = speed < t.maxSpeed && s.angularRate < t.maxRate;
        if (inside && calm) st.holdTime += s.dt;
        else {
          st.holdTime = Math.max(0, st.holdTime - s.dt * 2);
          if (!inside && horiz < t.radius * 6) this.warning = { key: 'task.outOfZone', params: { r: t.radius } };
          else if (inside) this.warning = { key: 'mission.unstable' };
        }
        st.progress = st.holdTime / t.hold;
        if (st.holdTime >= t.hold) this.finishTask();
        break;
      }
      case 'waypoint': {
        const d = Math.hypot(s.position.x - t.point.x, s.position.y - t.point.y, s.position.z - t.point.z);
        st.progress = Math.max(0, Math.min(1, 1 - (d - t.radius) / 60));
        if (d <= t.radius) this.finishTask();
        break;
      }
      case 'inspect': {
        const dx = t.target.x - s.cameraPosition.x;
        const dy = t.target.y - s.cameraPosition.y;
        const dz = t.target.z - s.cameraPosition.z;
        this.range = Math.hypot(dx, dy, dz);
        const dot = this.range > 1e-6 ? (dx * s.cameraDirection.x + dy * s.cameraDirection.y + dz * s.cameraDirection.z) / this.range : 1;
        this.offAxis = Math.acos(Math.max(-1, Math.min(1, dot))) * DEG;
        const framed = this.range >= t.minRange && this.range <= t.maxRange && this.offAxis <= t.maxOffAxis;
        if (st.ready) {
          if (this.range > t.maxRange * 1.3 || this.offAxis > t.maxOffAxis * 1.6) {
            st.ready = false;
            st.holdTime = 0;
          }
          break;
        }
        if (framed) {
          if (s.cameraMode !== 'operational') this.warning = { key: 'mission.cameraNeeded' };
          else if (s.lightLevel < this.config.minLightForRecord)
            this.warning = { key: 'mission.needLights', params: { v: Math.round(this.config.minLightForRecord * 100) } };
          else if (!stable) this.warning = { key: 'mission.unstable' };
          if (this.warning) st.holdTime = Math.max(0, st.holdTime - s.dt * 2);
          else st.holdTime += s.dt;
        } else {
          st.holdTime = Math.max(0, st.holdTime - s.dt * 3);
          if (this.range < t.minRange) this.warning = { key: 'mission.tooClose' };
        }
        st.progress = Math.min(1, st.holdTime / t.hold);
        if (st.holdTime >= t.hold) st.ready = true;
        break;
      }
    }
  }

  confirm(): Objective | null {
    const t = this.current;
    if (t?.kind === 'inspect' && this.st?.ready) {
      this.stats.inspections.push({ id: t.id, labelKey: t.labelKey, time: this.time, range: this.range, offAxis: this.offAxis });
      this.finishTask();
      return { key: 'mission.recorded', params: { label: t.labelKey } };
    }
    return null;
  }

  objective(): Objective {
    const t = this.current;
    if (!t) return { key: 'stage.complete' };
    const st = this.st;
    switch (t.kind) {
      case 'check':
        return { key: t.labelKey + '.obj', params: t.params?.(this.lastInput) };
      case 'translate': {
        const dir = t.axis === 'surge' ? (t.distance > 0 ? 'fwd' : 'back') : t.axis === 'sway' ? (t.distance > 0 ? 'right' : 'left') : t.distance > 0 ? 'up' : 'down';
        const done = (st?.progress ?? 0) * Math.abs(t.distance);
        return { key: `task.translate.${dir}`, params: { d: Math.abs(t.distance), done: done.toFixed(1) } };
      }
      case 'heading':
        return { key: 'task.heading', params: { h: String(t.heading).padStart(3, '0'), tol: t.tolerance, s: Math.max(0, t.hold - (st?.holdTime ?? 0)).toFixed(1) } };
      case 'depth':
        return { key: 'task.depth', params: { d: t.depth, tol: t.tolerance, s: Math.max(0, t.hold - (st?.holdTime ?? 0)).toFixed(1) } };
      case 'track':
        return { key: 'task.track', params: { h: String(t.heading).padStart(3, '0'), d: t.distance, done: (st?.covered ?? 0).toFixed(1) } };
      case 'station':
        return { key: 'task.station', params: { r: t.radius, s: Math.max(0, t.hold - (st?.holdTime ?? 0)).toFixed(1) } };
      case 'waypoint':
        return { key: 'task.waypoint', params: { label: t.labelKey, r: t.radius } };
      case 'inspect':
        if (st?.ready) return { key: 'mission.confirm' };
        return { key: 'task.inspect', params: { label: t.labelKey, min: t.minRange, max: t.maxRange, deg: t.maxOffAxis } };
    }
  }

  hint(): Objective | null {
    const t = this.current;
    if (!t) return null;
    if (t.hintKey) return { key: t.hintKey };
    return { key: `hint.task.${t.kind}` };
  }

  holdProgress(): number | null {
    const t = this.current;
    if (!t || !this.st) return null;
    return Math.max(0, Math.min(1, this.st.progress));
  }

  targetGeometry(): { range: number; offAxis: number } | null {
    return this.current?.kind === 'inspect' ? { range: this.range, offAxis: this.offAxis } : null;
  }

  steps(): MissionStep[] {
    return this.config.tasks.map((t, i) => ({ key: t.labelKey, state: i < this.index ? 'done' : i === this.index ? 'active' : 'pending' }));
  }

  stepIndex(): number {
    return Math.min(this.index, this.config.tasks.length - 1);
  }

  stageKey(): string {
    return this.current?.labelKey ?? 'stage.complete';
  }

  prepChecklist(): null {
    return null;
  }

  navTarget(): V3 | null {
    const t = this.current;
    if (!t) return null;
    if (t.kind === 'waypoint') return t.point;
    if (t.kind === 'inspect') return t.target;
    if (t.kind === 'station' && t.point) return t.point;
    return null;
  }

  navTargetLabel(): string | null {
    const t = this.current;
    return t && (t.kind === 'waypoint' || t.kind === 'inspect' || (t.kind === 'station' && t.point)) ? t.id : null;
  }

  markers(): MissionMarker[] {
    const out: MissionMarker[] = [];
    this.config.tasks.forEach((t, i) => {
      const state = i < this.index ? 'done' : i === this.index ? 'active' : 'pending';
      if (t.kind === 'waypoint') out.push({ id: t.id, kind: 'gate', position: t.point, radius: t.radius, normal: t.gate, label: t.id, state });
      else if (t.kind === 'inspect') out.push({ id: t.id, kind: 'target', position: t.post ?? t.target, radius: 0.3, label: t.id, state });
      else if (t.kind === 'station' && t.point) out.push({ id: t.id, kind: 'zone', position: t.point, radius: t.radius, label: t.id, state });
    });
    return out;
  }

  notifyCameraToggled(): void {}

  recordCollision(c: CollisionRecord): void {
    if (!this.complete) this.stats.collisions.push(c);
  }

  consumeLaunchRequest(): boolean {
    return false;
  }

  consumeRecoveryRequest(): boolean {
    return false;
  }

  condition(): 'ok' | 'minor' | 'damage' {
    return conditionFromCollisions(this.stats.collisions);
  }

  reportLines(): { labelKey: string; value: string; status?: 'ok' | 'warn' | 'alarm' }[] {
    const done = this.stats.tasks.length;
    const total = this.config.tasks.length;
    return [
      {
        labelKey: 'report.tasks',
        value: `${done}/${total}`,
        status: done >= total ? 'ok' : 'warn',
      },
      {
        labelKey: 'report.taskTimes',
        value: this.stats.tasks.map((t) => `${t.id} · ${t.duration.toFixed(0)} s`).join('<br>') || '—',
      },
    ];
  }
}
