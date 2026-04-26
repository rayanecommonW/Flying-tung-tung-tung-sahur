/**
 * Wire protocol contract between backend and frontend for the PvP v1
 * networking layer. Every event name + payload shape lives here and is
 * the single source of truth for both sides.
 *
 * See `plans/networking/01_PROTOCOL.md` for prose. JSON only — no binary
 * encoding in v1. Quaternions and vectors are plain objects (`{x,y,z,w}`,
 * `{x,y,z}`); converted to/from `THREE.Quaternion` / `THREE.Vector3` only
 * at the rendering layer.
 */

import type { Vec3, Vec4 } from './types';

// =============================================================================
// Event names
// =============================================================================

export const EVENTS = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  PING: 'ping',
  PONG: 'pong',
  INPUT: 'input',
  SNAPSHOT: 'snapshot',
  PLAYER_JOINED: 'playerJoined',
  PLAYER_LEFT: 'playerLeft',
  KICKED: 'kicked',
  /** Reserved for v2 text chat — name only, no payload yet. */
  CHAT: 'chat',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

// =============================================================================
// DTOs (used inside payloads)
// =============================================================================

/** Player state as it appears on the wire. */
export interface PlayerStateDto {
  id: string;
  position: Vec3;
  velocity: Vec3;
  orientation: Vec4;
  hp: number;
  lives: number;
  alive: boolean;
  turbo: boolean;
}

/** Projectile state as it appears on the wire. */
export interface ProjectileStateDto {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  /** Sim-seconds remaining before lifetime expiry. */
  ttl: number;
}

export interface SpawnEventDto {
  tick: number;
  projectileId: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
}

export type DespawnReason =
  | 'expired'
  | 'hit-player'
  | 'hit-building'
  | 'hit-ground'
  | 'out-of-bounds';

export interface DespawnEventDto {
  tick: number;
  projectileId: number;
  reason: DespawnReason;
  position: Vec3;
}

export interface HitEventDto {
  tick: number;
  victimId: string;
  attackerId: string;
  projectileId: number;
  position: Vec3;
  livesLeft: number;
}

export interface DeathEventDto {
  tick: number;
  victimId: string;
  attackerId: string | null;
  position: Vec3;
}

export interface RespawnEventDto {
  tick: number;
  playerId: string;
  position: Vec3;
  orientation: Vec4;
}

// =============================================================================
// C→S: hello
// =============================================================================

export interface HelloPayload {
  /** Display name — server sanitizes (trim, length-cap 24, strip control chars). */
  name: string;
  /** Protocol version baked into the shared package. Server kicks on mismatch. */
  protocolVersion: number;
  /** Client `performance.now()` at send; echoed in welcome for first RTT estimate. */
  clientTimeMs: number;
}

// =============================================================================
// S→C: welcome
// =============================================================================

export interface WelcomeOtherPlayer {
  id: string;
  name: string;
  position: Vec3;
  orientation: Vec4;
  hp: number;
  lives: number;
  alive: boolean;
}

export interface WelcomePayload {
  /** Player's id == socket.id. */
  playerId: string;
  /** Server tick at the moment of welcome. */
  serverTick: number;
  /** Server time at welcome. */
  serverTimeMs: number;
  /** Server tick rate so the client knows scaling. */
  serverTickHz: number;
  /** Snapshot rate so the client can size its interpolation buffer. */
  snapshotHz: number;
  /** Authoritative city seed so all clients render the same procedural map. */
  citySeed: number;
  /** Initial pose. The client snaps the local plane to this. */
  spawn: {
    position: Vec3;
    orientation: Vec4;
  };
  /** Current roster excluding self. */
  others: WelcomeOtherPlayer[];
  /** Echoed `hello.clientTimeMs` for the first RTT estimate. */
  clientTimeMs: number;
}

// =============================================================================
// C↔S: ping/pong (clock sync)
// =============================================================================

export interface PingPayload {
  clientSendTimeMs: number;
}

export interface PongPayload {
  /** Echoed verbatim. */
  clientSendTimeMs: number;
  /** Server-monotonic ms at the moment the server saw the ping. */
  serverTimeMs: number;
  /** Bonus alignment data — the server's tick when the ping was received. */
  serverTick: number;
}

// =============================================================================
// C→S: input
// =============================================================================

export interface InputAxes {
  /** Signed [-1, +1], pre-saturated through tanh on the client. */
  pitch: number;
  /** Signed [-1, +1], pre-saturated through tanh on the client. */
  yaw: number;
  /** Signed [-1, +1] — reserved; v1 always 0. */
  roll: number;
  /** [0, 1]; the server multiplies by TURBO_MULT if `turbo` is held. */
  throttle: number;
}

export interface InputPayload {
  /** Monotonic per-client input number, starts at 1 on connect. */
  seq: number;
  /** Sim-seconds this input represents (sum of batched local sub-ticks). */
  dt: number;
  /** `performance.now()` at send — telemetry only, not used for sim. */
  clientTimeMs: number;
  axes: InputAxes;
  /** Held this tick: turbo on. */
  turbo: boolean;
  /** Edge-triggered: client wants to fire a projectile. */
  fire: boolean;
  /** Edge-triggered: dodge requested. */
  dodge: boolean;
}

// =============================================================================
// S→all: snapshot
// =============================================================================

export interface SnapshotEvents {
  spawns: SpawnEventDto[];
  despawns: DespawnEventDto[];
  hits: HitEventDto[];
  deaths: DeathEventDto[];
  respawns: RespawnEventDto[];
}

export interface SnapshotAck {
  id: string;
  seq: number;
}

export interface SnapshotPayload {
  /** Server tick at the moment this snapshot was generated. */
  tick: number;
  /** Server time at the moment this snapshot was generated. */
  serverTimeMs: number;
  players: PlayerStateDto[];
  projectiles: ProjectileStateDto[];
  /** Highest input.seq the server has consumed per recipient. */
  acks: SnapshotAck[];
  events: SnapshotEvents;
}

// =============================================================================
// S→all: playerJoined / playerLeft
// =============================================================================

export interface PlayerJoinedPayload {
  player: {
    id: string;
    name: string;
    position: Vec3;
    orientation: Vec4;
    hp: number;
    lives: number;
    alive: boolean;
  };
}

export type PlayerLeftReason = 'disconnect' | 'timeout' | 'kicked';

export interface PlayerLeftPayload {
  id: string;
  reason: PlayerLeftReason;
}

// =============================================================================
// S→C: kicked
// =============================================================================

export type KickedReason = 'room-full' | 'version-mismatch' | 'banned';

export interface KickedPayload {
  reason: KickedReason;
  message: string;
  serverProtocolVersion?: number;
}

// =============================================================================
// Reserved for v2: chat
// =============================================================================

export interface ChatPayloadC2S {
  message: string;
}

export interface ChatPayloadS2A {
  from: string;
  message: string;
}

// =============================================================================
// Backward-compat re-exports
// =============================================================================

/**
 * Pre-MP placeholder shapes — kept around so any legacy import compiles
 * during the multiplayer transition. Prefer the fully-typed events above.
 *
 * @deprecated use `HelloPayload`
 */
export type JoinPayload = HelloPayload;

/** @deprecated use `SnapshotPayload` */
export type WorldStatePayload = SnapshotPayload;

/** @deprecated use `HitEventDto` */
export type PlayerHitPayload = HitEventDto;

/** @deprecated use `InputPayload.fire` flag in v2 protocol */
export interface ShootPayload {
  tick: number;
}
