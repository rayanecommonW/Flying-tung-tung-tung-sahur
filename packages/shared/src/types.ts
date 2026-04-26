/**
 * Shared types used by both the frontend (Three.js client) and the backend
 * (Bun + Hono + Socket.IO server). Keeping them here ensures the wire
 * protocol stays in sync as we add real-time PvP later.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Quaternion (x, y, z, w). w is the scalar component. */
export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Authoritative state of a single player's plane.
 * The local player and any future remote players use this same shape.
 *
 * Orientation is stored as a quaternion to keep loops, barrel rolls, and
 * continuous yaws gimbal-lock free. The Euler triple (yaw/pitch/roll) is
 * kept around as a *display* convenience (HUD, debug, banking visuals)
 * but is no longer authoritative for direction.
 */
export interface PlayerState {
  id: string;
  position: Vec3;
  velocity: Vec3;
  /** Authoritative orientation as a unit quaternion. */
  orientation: Vec4;
  /** Derived yaw around world Y (radians) — for HUD/debug only. */
  yaw: number;
  /** Derived pitch around local X (radians) — for HUD/debug only. */
  pitch: number;
  /** Visual roll for banking (radians) — applied at render time. */
  roll: number;
  /**
   * Visual roll added by an active side-barrel dodge (radians, can spin past
   * 2π). Composed on top of `roll` purely at render time so the plane comes
   * out level when the dodge ends.
   */
  dodgeRoll: number;
  /** Turbo currently engaged. */
  turbo: boolean;
  /**
   * Remaining lives. Starts at `PLAYER.MAX_LIVES`; each fatal collision
   * decrements by 1. When it reaches 0, `dead` is set and the respawn
   * modal flow begins.
   */
  lives: number;
  /** Player is in the dying state — controller and physics freeze. */
  dead: boolean;
}

/**
 * Per-tick player input. The local mouse layer fills this in; later, the
 * networking layer will buffer/transmit identical structs for remote players.
 *
 * Pointer-lock model: mouse deltas accumulate per browser mousemove event
 * and are consumed (zeroed) by the controller every fixed tick.
 */
export interface PlayerInput {
  /** Pixel deltas accumulated since the last consume. Browser convention: +y is down. */
  mouseDelta: { x: number; y: number };
  /** Edge-triggered shoot — currently fired by the "K" key. */
  shootPressed: boolean;
  /** Edge-triggered side-barrel dodge — currently fired by right mouse click. */
  dodgePressed: boolean;
  /** Held = turbo on. Currently bound to left mouse. */
  turbo: boolean;
  /** True while the browser has granted pointer lock on our canvas. */
  pointerLocked: boolean;
  /**
   * If false, the input layer suppresses canvas-click pointer-lock requests.
   * Set false while the respawn modal is showing so the OS cursor remains
   * visible and the player can click the button.
   */
  allowLock: boolean;
}

export interface ProjectileState {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  /** Seconds since spawn. */
  ageSec: number;
  alive: boolean;
}
