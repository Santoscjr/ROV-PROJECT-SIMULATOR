/**
 * Vehicle parameters for the simulated work-class ROV.
 *
 * Body frame convention (used everywhere in the simulator):
 *   +X forward (bow), +Y up, +Z starboard (right). Origin at the centre of gravity.
 *
 * Mass, inertia and hydrodynamic coefficients are approximations in the order
 * of magnitude of the RexROV model distributed with UUV Simulator
 * (uuvsimulator/uuv_simulator, Apache-2.0), itself derived from a real
 * work-class vehicle. Only the published numeric magnitudes were used as a
 * reference; no code was reused. This is NOT a certified dynamic model.
 */

export type Vec3Tuple = [number, number, number];

export interface ThrusterSpec {
  id: string;
  /** Position in body frame (m). */
  position: Vec3Tuple;
  /** Unit direction of positive thrust in body frame. */
  direction: Vec3Tuple;
  /** Max forward thrust (N). */
  maxForward: number;
  /** Max reverse thrust (N) — propellers are less efficient in reverse. */
  maxReverse: number;
  /** First-order response time constant (s). */
  timeConstant: number;
}

const S = Math.SQRT1_2;

export const THRUSTERS: ThrusterSpec[] = [
  // Horizontal vectored thrusters (45°)
  { id: 'H-FP', position: [0.95, -0.3, -0.62], direction: [S, 0, S], maxForward: 1000, maxReverse: 800, timeConstant: 0.3 },
  { id: 'H-FS', position: [0.95, -0.3, 0.62], direction: [S, 0, -S], maxForward: 1000, maxReverse: 800, timeConstant: 0.3 },
  { id: 'H-AP', position: [-0.95, -0.3, -0.62], direction: [S, 0, -S], maxForward: 1000, maxReverse: 800, timeConstant: 0.3 },
  { id: 'H-AS', position: [-0.95, -0.3, 0.62], direction: [S, 0, S], maxForward: 1000, maxReverse: 800, timeConstant: 0.3 },
  // Vertical thrusters
  { id: 'V-FP', position: [0.7, 0.15, -0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.3 },
  { id: 'V-FS', position: [0.7, 0.15, 0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.3 },
  { id: 'V-AP', position: [-0.7, 0.15, -0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.3 },
  { id: 'V-AS', position: [-0.7, 0.15, 0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.3 },
];

export interface RovParams {
  /** Dry mass (kg). */
  mass: number;
  /** Rigid-body principal inertia about body X, Y, Z (kg·m²). */
  inertia: Vec3Tuple;
  /** Added mass, translational X, Y, Z (kg). */
  addedMass: Vec3Tuple;
  /** Added inertia, rotational X, Y, Z (kg·m²). */
  addedInertia: Vec3Tuple;
  /** Linear damping, translational (N per m/s). */
  linDamp: Vec3Tuple;
  /** Quadratic damping, translational (N per (m/s)²). */
  quadDamp: Vec3Tuple;
  /** Linear damping, rotational (N·m per rad/s). */
  linDampRot: Vec3Tuple;
  /** Quadratic damping, rotational (N·m per (rad/s)²). */
  quadDampRot: Vec3Tuple;
  /** Net buoyancy in water as a fraction of weight (positive = floats up). */
  buoyancyMargin: number;
  /** Centre of buoyancy in body frame (m) — above CG gives passive roll/pitch stability. */
  centerOfBuoyancy: Vec3Tuple;
  /**
   * Centre of pressure for translational drag (body frame, m). Offset aft and
   * below the CG so the vehicle weathervanes into the current and squats
   * slightly when surging, as an open-frame vehicle does.
   */
  centerOfPressure: Vec3Tuple;
  /** Vehicle envelope (m): length, height, width. */
  size: Vec3Tuple;
  /** Collision sphere radius (m). */
  collisionRadius: number;
  gravity: number;
  thrusters: ThrusterSpec[];
}

export const DEFAULT_ROV_PARAMS: RovParams = {
  mass: 1860,
  inertia: [525, 690, 795],
  addedMass: [780, 3660, 1220],
  addedInertia: [530, 680, 1000],
  // Low-speed linear damping raised over RexROV to include umbilical drag.
  linDamp: [220, 730, 220],
  quadDamp: [750, 1820, 990],
  // Rotational damping raised above the RexROV figures to account for the
  // umbilical and open-frame appendages; gives turn rates of ~60°/s at full yaw.
  linDampRot: [400, 500, 450],
  quadDampRot: [900, 1400, 1000],
  buoyancyMargin: 0.008,
  centerOfBuoyancy: [0, 0.18, 0],
  centerOfPressure: [-0.1, -0.15, 0],
  size: [2.6, 1.6, 1.6],
  collisionRadius: 1.15,
  gravity: 9.81,
  thrusters: THRUSTERS,
};
