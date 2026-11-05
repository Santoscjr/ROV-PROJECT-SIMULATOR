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
  /**
   * Motor/propeller speed first-order time constant (s). Since v2.0 this is
   * the time constant of the propeller *speed* n, not of the force: thrust
   * follows n|n|, so the force response is slower at the start (S-shaped).
   */
  timeConstant: number;
  /** Propeller speed slew limit, fraction of rated speed per second (default 2.5 /s). */
  slewRate?: number;
  /** Hydraulic/electric power drawn at rated speed (W, default 15 kW). */
  maxPower?: number;
  /**
   * Advance-loss reference speed (m/s, default 8): thrust is reduced by the
   * factor (1 − u_a / (|n|·advanceSpeed)) where u_a is the inflow speed along
   * the thrust axis. Equivalent to a linear K_T(J) = K_T0·(1 − J/J0) curve.
   */
  advanceSpeed?: number;
}

const S = Math.SQRT1_2;

export const THRUSTERS: ThrusterSpec[] = [
  // Horizontal vectored thrusters (45°)
  { id: 'H-FP', position: [0.95, -0.3, -0.62], direction: [S, 0, S], maxForward: 1000, maxReverse: 800, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  { id: 'H-FS', position: [0.95, -0.3, 0.62], direction: [S, 0, -S], maxForward: 1000, maxReverse: 800, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  { id: 'H-AP', position: [-0.95, -0.3, -0.62], direction: [S, 0, -S], maxForward: 1000, maxReverse: 800, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  { id: 'H-AS', position: [-0.95, -0.3, 0.62], direction: [S, 0, S], maxForward: 1000, maxReverse: 800, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  // Vertical thrusters
  { id: 'V-FP', position: [0.7, 0.15, -0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  { id: 'V-FS', position: [0.7, 0.15, 0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  { id: 'V-AP', position: [-0.7, 0.15, -0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
  { id: 'V-AS', position: [-0.7, 0.15, 0.5], direction: [0, 1, 0], maxForward: 900, maxReverse: 750, timeConstant: 0.15, slewRate: 2.5, maxPower: 15000, advanceSpeed: 8 },
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
  /**
   * Total power available to the thrusters (W) — the HPU / power-can limit
   * shared by all of them. When the commanded set would exceed it, every
   * command is scaled by the same factor (wrench direction preserved).
   */
  powerBudget?: number;
  /** Umbilical termination point in body frame (m), where the tether force acts. */
  tetherAttach?: Vec3Tuple;
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
  // Fictitious "150 hp" class: ~112 kW electric → ~85 kW hydraulic, of which
  // ~66 kW reaches the thruster valve pack (the rest: tooling circuit
  // stand-by, valve and line losses). 8 × 15 kW at rated speed = 120 kW.
  // Effect: heave alone (60 kW) is unrestricted, full surge (≈74 kW) is
  // trimmed to ≈93 % thrust and surge + heave together to ≈88 %.
  // Plausible orders of magnitude only.
  powerBudget: 66000,
  // Umbilical termination on the aft top of the vehicle (matches the 3D model's
  // bend restrictor): the tether force acts here, so it also produces torque.
  tetherAttach: [-0.6, 1.05, 0],
};
