import { terrainHeight } from './terrain';

/**
 * Data-driven description of the offshore inspection site. Shared by the
 * renderer (to build meshes), the physics (colliders, altimeter) and the
 * mission logic (inspection points). World frame: +Y up, north = -Z, east = +X.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Box collider rotated about the vertical axis. */
export interface BoxCollider {
  kind: 'box';
  center: V3;
  half: V3;
  /** rotation about +Y (rad) */
  yaw: number;
}

/** Capsule collider (pipes, spools). */
export interface CapsuleCollider {
  kind: 'capsule';
  a: V3;
  b: V3;
  radius: number;
}

export type Collider = BoxCollider | CapsuleCollider;

export interface InspectionPoint {
  id: string;
  /** i18n key of the label */
  labelKey: string;
  /** Point the camera must look at. */
  target: V3;
  /** Unit vector pointing from the target towards where the ROV should be. */
  approach: V3;
  minRange: number;
  maxRange: number;
  /** Max angle between camera axis and line of sight to target (deg). */
  maxOffAxisDeg: number;
  /** Seconds of stable hold required. */
  holdSeconds: number;
}

const ground = (x: number, z: number) => terrainHeight(x, z);
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return v(a.x / l, a.y / l, a.z / l);
};

/** Support vessel (surface). Bow points north (-Z). */
export const VESSEL = {
  center: v(0, 0, 0),
  length: 78,
  beam: 18,
  draft: 6.2,
};

/** Launch & recovery point: alongside the starboard side, under the crane. */
export const LAUNCH_POINT = v(VESSEL.beam / 2 + 4.5, 0, 6);
/**
 * Tether Management System: hangs from the vessel's main umbilical below the
 * launch point (simplified: fixed position). The ROV tether leaves through the
 * bottom fairlead at `TMS.exit`.
 */
export const TMS = {
  position: v(LAUNCH_POINT.x, -70, LAUNCH_POINT.z),
  exit: v(LAUNCH_POINT.x, -71.45, LAUNCH_POINT.z),
};
/** Height of the ROV hanging on the crane before launch. */
export const LAUNCH_HANG_HEIGHT = 4.2;
/** Depth at which the crane releases the vehicle (m). */
export const LAUNCH_RELEASE_DEPTH = 8;
/** Recovery: the ROV must return under the crane, shallower than this. */
export const RECOVERY_RADIUS = 7;
export const RECOVERY_DEPTH = 12;

// --- Subsea manifold -------------------------------------------------------
const MF_X = 28;
const MF_Z = -80;
const MF_YAW = (15 * Math.PI) / 180;
const MF_G = ground(MF_X, MF_Z);
export const MANIFOLD = {
  position: v(MF_X, MF_G, MF_Z),
  yaw: MF_YAW,
  size: v(11, 4.2, 7), // length (local X), height, width (local Z)
};

/** Transform a manifold-local point to world. */
export function manifoldToWorld(lx: number, ly: number, lz: number): V3 {
  const c = Math.cos(MF_YAW);
  const s = Math.sin(MF_YAW);
  // rotation about +Y: x' = x cos + z sin ; z' = -x sin + z cos
  return v(MF_X + lx * c + lz * s, MF_G + ly, MF_Z - lx * s + lz * c);
}

// --- Wet christmas tree -----------------------------------------------------
const TR_X = 6;
const TR_Z = -93;
export const TREE = {
  position: v(TR_X, ground(TR_X, TR_Z), TR_Z),
  yaw: (-20 * Math.PI) / 180,
  size: v(3.6, 4.6, 3.6),
};

// --- Rigid jumper (tree -> manifold) ------------------------------------------
const JUMPER_R = 0.17;
const jumperStart = (() => {
  // Tree production hub at local (1.9, 2.6, 0.6), rotated with the tree.
  const c = Math.cos(TREE.yaw);
  const s = Math.sin(TREE.yaw);
  return v(TREE.position.x + 1.9 * c + 0.6 * s, TREE.position.y + 2.6, TREE.position.z - 1.9 * s + 0.6 * c);
})();
const jumperEnd = manifoldToWorld(-5.6, 2.1, -1.6);
/** Inverted "M" spool: rises, spans and drops into the manifold hub. */
export const JUMPER_PATH: V3[] = (() => {
  const a = jumperStart;
  const b = jumperEnd;
  const mid = (t: number, h: number) => v(a.x + (b.x - a.x) * t, Math.max(a.y, b.y) + h, a.z + (b.z - a.z) * t);
  return [a, v(a.x + 1.2, a.y, a.z + 0.2), mid(0.12, 2.2), mid(0.45, 1.4), mid(0.55, 1.4), mid(0.88, 2.2), v(b.x - 1.2, b.y, b.z - 0.2), b];
})();
export const JUMPER_RADIUS = JUMPER_R;

// --- Export pipeline (manifold -> PLET), crossing a free span ---------------------
export const PIPELINE_RADIUS = 0.23;
const PL_START = manifoldToWorld(5.9, 0, 0.8);
const PL_END = v(118, 0, -60);
const PL_SAMPLES = 90;
/**
 * Pipeline centreline. The pipe lies on the seabed but, being stiff, bridges
 * depressions — which produces the free span inspected in the mission.
 */
export const PIPELINE_PATH: V3[] = (() => {
  const pts: V3[] = [];
  for (let i = 0; i <= PL_SAMPLES; i++) {
    const t = i / PL_SAMPLES;
    // slight lateral meander
    const x = PL_START.x + (PL_END.x - PL_START.x) * t;
    const z = PL_START.z + (PL_END.z - PL_START.z) * t + Math.sin(t * Math.PI * 1.3) * 3;
    pts.push(v(x, ground(x, z) + PIPELINE_RADIUS, z));
  }
  pts[0].y = MANIFOLD.position.y + 0.9;
  // Relaxation: a pipe cannot follow sharp dips (bending stiffness).
  for (let it = 0; it < 220; it++) {
    for (let i = 1; i < pts.length - 1; i++) {
      const rest = ground(pts[i].x, pts[i].z) + PIPELINE_RADIUS;
      const avg = (pts[i - 1].y + pts[i + 1].y) / 2;
      pts[i].y = Math.max(rest, avg - 0.012);
    }
  }
  return pts;
})();

export const PLET = {
  position: v(PL_END.x + 2.2, ground(PL_END.x + 2.2, PL_END.z), PL_END.z),
  size: v(4.4, 1.8, 3),
};

/** Find the point of the pipeline with the largest gap to the seabed. */
function freeSpanPoint(): { point: V3; gap: number; index: number } {
  let best = { point: PIPELINE_PATH[0], gap: 0, index: 0 };
  PIPELINE_PATH.forEach((p, i) => {
    // Ignore the riser section where the pipe lifts into the manifold hub.
    if (Math.hypot(p.x - PL_START.x, p.z - PL_START.z) < 15) return;
    const gap = p.y - PIPELINE_RADIUS - ground(p.x, p.z);
    if (gap > best.gap) best = { point: p, gap, index: i };
  });
  return best;
}
export const FREE_SPAN = freeSpanPoint();

// --- Colliders ---------------------------------------------------------------
function capsulesAlong(path: V3[], radius: number): CapsuleCollider[] {
  const out: CapsuleCollider[] = [];
  for (let i = 0; i < path.length - 1; i++) out.push({ kind: 'capsule', a: path[i], b: path[i + 1], radius });
  return out;
}

export const COLLIDERS: Collider[] = [
  {
    kind: 'box',
    center: v(MANIFOLD.position.x, MANIFOLD.position.y + MANIFOLD.size.y / 2, MANIFOLD.position.z),
    half: v(MANIFOLD.size.x / 2, MANIFOLD.size.y / 2, MANIFOLD.size.z / 2),
    yaw: MANIFOLD.yaw,
  },
  {
    kind: 'box',
    center: v(TREE.position.x, TREE.position.y + TREE.size.y / 2, TREE.position.z),
    half: v(TREE.size.x / 2, TREE.size.y / 2, TREE.size.z / 2),
    yaw: TREE.yaw,
  },
  {
    kind: 'box',
    center: v(PLET.position.x, PLET.position.y + PLET.size.y / 2, PLET.position.z),
    half: v(PLET.size.x / 2, PLET.size.y / 2, PLET.size.z / 2),
    yaw: 0,
  },
  ...capsulesAlong(JUMPER_PATH, JUMPER_R + 0.05),
  ...capsulesAlong(PIPELINE_PATH, PIPELINE_RADIUS),
];

// --- Inspection points ---------------------------------------------------------
const hubTarget = manifoldToWorld(-5.6, 2.1, -1.6);
const hubApproach = norm(v(-Math.cos(MF_YAW), 0.35, Math.sin(MF_YAW)));

const spanP = FREE_SPAN.point;
const spanNext = PIPELINE_PATH[Math.min(FREE_SPAN.index + 1, PIPELINE_PATH.length - 1)];
const pipeDir = norm(v(spanNext.x - spanP.x, 0, spanNext.z - spanP.z));
// Approach from the south side of the pipe, slightly above.
const side = v(-pipeDir.z, 0, pipeDir.x);
const spanApproach = norm(v(side.x * (side.z > 0 ? 1 : -1), 0.65, side.z * (side.z > 0 ? 1 : -1)));

// Christmas-tree ROV panel (south face of the tree frame, local −Z).
const treeLocal = (lx: number, ly: number, lz: number): V3 => {
  const c = Math.cos(TREE.yaw);
  const s = Math.sin(TREE.yaw);
  return v(TREE.position.x + lx * c + lz * s, TREE.position.y + ly, TREE.position.z - lx * s + lz * c);
};
const treePanel = treeLocal(0, 1.6, -TREE.size.z / 2 - 0.1);
const treeOut = treeLocal(0, 0, -1);
const treeApproach = norm(v(treeOut.x - TREE.position.x, 0.25, treeOut.z - TREE.position.z));

export const INSPECTION_POINTS: InspectionPoint[] = [
  {
    id: 'IP-01',
    labelKey: 'mission.ip01',
    target: v(hubTarget.x, hubTarget.y, hubTarget.z),
    approach: hubApproach,
    minRange: 1.6,
    maxRange: 5,
    maxOffAxisDeg: 15,
    holdSeconds: 8,
  },
  {
    id: 'IP-02',
    labelKey: 'mission.ip02',
    target: v(spanP.x, spanP.y - PIPELINE_RADIUS - FREE_SPAN.gap / 2, spanP.z),
    approach: spanApproach,
    minRange: 1.8,
    maxRange: 6,
    maxOffAxisDeg: 15,
    holdSeconds: 8,
  },
  {
    id: 'IP-03',
    labelKey: 'mission.ip03',
    target: treePanel,
    approach: treeApproach,
    minRange: 1.5,
    maxRange: 4.5,
    maxOffAxisDeg: 15,
    holdSeconds: 8,
  },
];
