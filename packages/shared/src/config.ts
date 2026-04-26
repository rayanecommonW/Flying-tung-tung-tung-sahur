/**
 * Gameplay tunables shared by client and (future) authoritative server.
 * Keeping the numbers here means a future server-side simulation runs
 * identical physics to the client out of the box.
 */

export const PLANE = {
  /** World units / second of forward motion when not boosting. */
  CRUISE_SPEED: 60,
  /** Multiplier on cruise speed while right-mouse is held. */
  TURBO_MULT: 2.2,
  /** Max yaw angular rate (rad/sec). */
  MAX_YAW_RATE: 1.6,
  /** Max pitch angular rate (rad/sec). */
  MAX_PITCH_RATE: 1.2,
  /** Max banking roll (rad). */
  MAX_ROLL: 0.9,
  /** Hard pitch clamp (rad) to prevent the camera flipping. */
  MAX_PITCH: 1.2,
  /** Yaw rate damping time constant (sec). Smaller = snappier. */
  TAU_YAW: 0.18,
  /** Pitch rate damping time constant (sec). */
  TAU_PITCH: 0.2,
  /** Roll smoothing time constant (sec). */
  TAU_ROLL: 0.12,
  /** Hard floor: plane never dives below this Y. */
  WORLD_FLOOR_Y: 2,
  /** Hard ceiling. */
  WORLD_CEIL_Y: 400,
  /** Soft horizontal half-extent before we auto-turn the plane back. */
  WORLD_HALF_SIZE: 1500,
  /** Cursor dead zone in normalized device coords. */
  DEAD_ZONE: 0.05,
} as const;

export const PROJECTILE = {
  POOL_SIZE: 256,
  /** Projectile speed (world units/sec). */
  SPEED: 200,
  LIFETIME_SEC: 2.5,
  COOLDOWN_SEC: 0.12,
  /** Collision sphere radius. */
  RADIUS: 0.3,
  COLOR: 0xfff09a,
} as const;

export const CITY = {
  SEED: 1337,
  GRID_SIZE: 40,
  CELL_SIZE: 30,
  ROAD_WIDTH: 6,
  MAX_BLDG_PER_CELL: 1,
  HEIGHT_MIN: 8,
  HEIGHT_MAX: 45,
  EMPTY_CHANCE: 0.12,
  PARK_CHANCE: 0.05,
} as const;

export const CAMERA = {
  /** Chase distance behind the plane. */
  DISTANCE: 12,
  /** Vertical offset above the plane. */
  HEIGHT: 3,
  /** Look-ahead distance in front of the plane. */
  LOOK_AHEAD: 8,
  /** Position smoothing time constant (sec). */
  TAU_POS: 0.12,
  /** FOV when cruising. */
  FOV_NORMAL: 70,
  /** FOV when turbo is engaged (gives a speed sensation). */
  FOV_TURBO: 84,
  /** FOV smoothing time constant. */
  TAU_FOV: 0.18,
} as const;

/** Fixed simulation timestep used by the deterministic game loop. */
export const FIXED_DT = 1 / 60;
