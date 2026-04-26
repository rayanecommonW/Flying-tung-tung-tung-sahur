/**
 * Gameplay tunables shared by client and (future) authoritative server.
 * Keeping the numbers here means a future server-side simulation runs
 * identical physics to the client out of the box.
 */

export const PLANE = {
  /** World units / second of forward motion when not boosting. */
  CRUISE_SPEED: 60,
  /** Multiplier on cruise speed while turbo (left mouse) is held. */
  TURBO_MULT: 2.2,
  /** Mouse-delta sensitivity (radians per CSS pixel) for yaw. */
  YAW_SENSITIVITY: 0.0028,
  /** Mouse-delta sensitivity (radians per CSS pixel) for pitch. */
  PITCH_SENSITIVITY: 0.0026,
  /**
   * If false (default, FPS-style): mouse-up = nose-down.
   * If true (flight-sim-style): mouse-up = nose-up.
   */
  INVERT_PITCH: false,
  /**
   * Soft cap on per-tick angular impulse (rad). The controller maps mouse
   * deltas through `tanh(input / MAX_TURN_PER_TICK) * MAX_TURN_PER_TICK`,
   * giving a saturating "rubber band" feel: small motions stay linear,
   * big swings hit a smooth ceiling so the further you push the harder
   * each extra pixel becomes.
   */
  MAX_TURN_PER_TICK: 0.32,
  /** Max banking roll (rad) when turning hard. */
  MAX_ROLL: 1.0,
  /** Roll smoothing time constant (sec). */
  TAU_ROLL: 0.12,
  /**
   * Smoothing time constant for the running average of mouse-x delta. Used
   * by the dodge system to pick a side: positive intent → dodge right.
   */
  YAW_INTENT_TAU: 0.25,
  /** Side-barrel dodge total duration (sec) — one full visual revolution. */
  DODGE_DURATION: 0.75,
  /**
   * Lateral peak speed during a dodge (world units/sec).
   * Total lateral travel ≈ DODGE_LATERAL_SPEED · DURATION · (2/π).
   * 240 × 0.75 × 0.6366 ≈ 115 world units — three city cells of clearance,
   * so the dodge actually moves you out of the path of incoming things.
   */
  DODGE_LATERAL_SPEED: 240,
  /** Cooldown between dodges (sec) — anti-spam. */
  DODGE_COOLDOWN: 0.9,
  /** Player collision sphere radius for plane-vs-building hit tests. */
  COLLIDER_RADIUS: 1.8,
  /** Hard floor: plane never dives below this Y. */
  WORLD_FLOOR_Y: 2,
  /** Hard ceiling. */
  WORLD_CEIL_Y: 600,
  /** Hard horizontal half-extent — position is clamped, but yaw is never forced. */
  WORLD_HALF_SIZE: 2200,
} as const;

export const PLAYER = {
  /** Lives the player starts (and respawns) with. */
  MAX_LIVES: 5,
  /**
   * Seconds of post-hit invulnerability granted after a non-fatal building
   * collision (and after respawn) so the player isn't immediately re-killed
   * while still inside / clipping through the same geometry.
   */
  IMMUNITY_SEC: 1.0,
} as const;

export const DEATH = {
  /** How long after a fatal (lives → 0) collision the respawn modal appears. */
  RESPAWN_DELAY_SEC: 2.0,
} as const;

export const PROJECTILE = {
  POOL_SIZE: 256,
  /** Projectile speed (world units/sec). */
  SPEED: 220,
  LIFETIME_SEC: 2.5,
  COOLDOWN_SEC: 0.12,
  /** Collision sphere radius. */
  RADIUS: 0.7,
  /** Visual halo radius — outer additive shell for the glow. */
  HALO_RADIUS: 1.6,
  COLOR: 0xfff09a,
  HALO_COLOR: 0xffae5a,
} as const;

export const CITY = {
  SEED: 1337,
  GRID_SIZE: 56,
  CELL_SIZE: 38,
  ROAD_WIDTH: 6,
  MAX_BLDG_PER_CELL: 1,
  HEIGHT_MIN: 12,
  HEIGHT_MAX: 180,
  /** Power applied to the unit-random height roll — >1 biases shorter, makes tall buildings rarer. */
  HEIGHT_GAMMA: 1.85,
  /** Per-cell chance a building gets the regular "skyscraper" multiplier on top of the base roll. */
  SKYSCRAPER_CHANCE: 0.06,
  /** Multiplier applied when SKYSCRAPER_CHANCE hits. */
  SKYSCRAPER_MULT: 1.7,
  /**
   * Per-cell chance a building is promoted to a "super-tall" landmark.
   * These ignore the normal roll and use SUPERTALL_BASE + rng() * SUPERTALL_RANGE,
   * so a few towers tower over everything else.
   */
  SUPERTALL_CHANCE: 0.012,
  SUPERTALL_BASE: 260,
  SUPERTALL_RANGE: 240,
  EMPTY_CHANCE: 0.06,
  PARK_CHANCE: 0.05,
  /**
   * Cells inside this Chebyshev radius of the spawn cell are forced empty,
   * guaranteeing the player has clear air around (0, *, 0) on respawn.
   * 4 = a 9×9 plaza ≈ 342 unit-wide buffer.
   */
  SPAWN_SAFE_RADIUS_CELLS: 4,
} as const;

export const CAMERA = {
  /** Chase distance behind the plane. */
  DISTANCE: 12,
  /** Vertical offset above the plane (in plane-local up, so it follows loops). */
  HEIGHT: 3,
  /** Look-ahead distance in front of the plane. */
  LOOK_AHEAD: 8,
  /** Position smoothing time constant (sec). */
  TAU_POS: 0.12,
  /**
   * Up-vector smoothing time constant (sec). The camera tracks the plane's
   * local up (orientation × world-up) but eases toward it so loops feel
   * like one continuous arc instead of a snap when crossing 90°.
   */
  TAU_UP: 0.16,
  /** FOV when cruising. */
  FOV_NORMAL: 70,
  /** FOV when turbo is engaged — Quake-Pro-wide for a strong speed rush. */
  FOV_TURBO: 105,
  /** FOV smoothing time constant. */
  TAU_FOV: 0.14,
  /** Camera-shake amplitude (world units) at full turbo. */
  SHAKE_TURBO: 0.18,
  /** Shake ramp-in/out time constant (sec). */
  TAU_SHAKE: 0.08,
} as const;

export const PARTICLES = {
  /** Pool size — must comfortably exceed (max emit rate × max lifetime + bursts). */
  POOL_SIZE: 800,
  /** Emissions per second when not boosting. */
  EMIT_RATE_NORMAL: 50,
  /** Emissions per second while turbo is held. */
  EMIT_RATE_TURBO: 220,
  /** Particle lifetime (sec) when not boosting. */
  LIFETIME_NORMAL: 0.55,
  /** Particle lifetime (sec) while turbo is held. */
  LIFETIME_TURBO: 0.9,
  /** Backward speed away from the plane (world units/sec). */
  BACKWARD_SPEED: 18,
  /** Random scatter component (world units/sec) — keep tight for a thin trail. */
  SCATTER_SPEED: 0.9,
  /**
   * Particle base size. The shader scales by (PARTICLES.PIXEL_SCALE / -z) and
   * by devicePixelRatio, so these values map roughly to on-screen pixels at
   * 20 units distance. Keep small — we want a thin trail, not a wall of fog.
   */
  SIZE_NORMAL: 4,
  SIZE_TURBO: 11,
  /** Numerator of the depth-attenuation term in the vertex shader. */
  PIXEL_SCALE: 20,
  /** ===== Impact bursts (used by collision systems) ===== */
  /** Particles spawned when a projectile hits a building. */
  BURST_BUILDING_COUNT: 22,
  /** Particles spawned when a projectile hits the ground. */
  BURST_GROUND_COUNT: 14,
  /** Particles spawned when the player crashes into a building. */
  BURST_PLAYER_DEATH_COUNT: 110,
  /** Burst particle outward speed (world units/sec). */
  BURST_SPEED: 22,
  /** Player-death burst speed — faster, fills the air with debris. */
  BURST_PLAYER_DEATH_SPEED: 55,
  /** Burst particle lifetime (sec). */
  BURST_LIFETIME: 0.55,
  /** Player-death burst lifetime (sec). */
  BURST_PLAYER_DEATH_LIFETIME: 1.6,
  /** Burst particle base size — bigger than trail so the boom reads. */
  BURST_SIZE: 14,
  /** Player-death burst size — much bigger so the explosion reads even at a distance. */
  BURST_PLAYER_DEATH_SIZE: 28,
  /** Building-hit color (warm orange). */
  BURST_COLOR_BUILDING: 0xffa64d,
  /** Ground-hit color (dusty tan). */
  BURST_COLOR_GROUND: 0xd9b27a,
  /** Player-death color (red-orange flame). */
  BURST_COLOR_PLAYER_DEATH: 0xff5022,
} as const;

/** Fixed simulation timestep used by the deterministic game loop. */
export const FIXED_DT = 1 / 60;
