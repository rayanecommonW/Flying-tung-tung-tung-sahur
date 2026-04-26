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

/**
 * Authoritative state of a single player's plane.
 * The local player and any future remote players use this same shape.
 */
export interface PlayerState {
  id: string;
  position: Vec3;
  velocity: Vec3;
  /** Heading around world Y (radians). */
  yaw: number;
  /** Pitch around local X (radians). */
  pitch: number;
  /** Visual roll for banking (radians). */
  roll: number;
  /** Turbo currently engaged. */
  turbo: boolean;
}

/**
 * Per-tick player input. The local mouse layer fills this in; later, the
 * networking layer will buffer/transmit identical structs for remote players.
 */
export interface PlayerInput {
  /** Cursor in normalized device coordinates: [-1, 1] on each axis. */
  cursorNdc: { x: number; y: number };
  /** Edge-triggered fire (consumed once per tick). */
  shootPressed: boolean;
  /** Right mouse held = turbo on. */
  turbo: boolean;
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
