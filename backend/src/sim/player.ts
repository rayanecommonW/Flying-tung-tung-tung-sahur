/**
 * Server-side player entity. Owns simulation state + per-socket networking
 * book-keeping (input queue, heartbeat, lastAppliedSeq). Sized for the v1
 * MVP — no rate limiting, no validation beyond "monotonic seq" / "alive
 * gates fire+dodge".
 */

import type { Socket } from 'socket.io';
import type { InputPayload, PlayerStateDto, Vec3, Vec4 } from '@flying-tung-tung/shared';
import { PLAYER, PLANE } from '@flying-tung-tung/shared';
import type { PlayerSimState } from '@flying-tung-tung/shared';

export interface ServerPlayer extends PlayerSimState {
  id: string;
  socket: Socket;
  name: string;
  hp: number;
  lives: number;
  alive: boolean;

  // ===== Networking book-keeping =====
  inputQueue: InputPayload[];
  lastAppliedSeq: number;
  /** serverTimeMs of last fired projectile — for cooldown gate. */
  lastShotAt: number;
  /** serverTimeMs until which damage is suppressed. */
  immunityUntil: number;

  // ===== Lifecycle =====
  joinedAt: number;
  /** serverTimeMs of last `input` or `ping` we received. */
  lastHeardAt: number;
  /** serverTimeMs at which the player should be respawned, or null. */
  pendingRespawnAt: number | null;
}

export function createServerPlayer(
  socket: Socket,
  name: string,
  spawn: { position: Vec3; orientation: Vec4 },
  now: number
): ServerPlayer {
  return {
    id: socket.id,
    socket,
    name,

    position: { ...spawn.position },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { ...spawn.orientation },
    turbo: false,

    dodgeActive: false,
    dodgeAccumulator: 0,
    dodgeDir: 1,
    dodgeCooldownLeft: 0,
    dodgeRoll: 0,

    hp: PLAYER.MAX_LIVES,
    lives: PLAYER.MAX_LIVES,
    alive: true,

    inputQueue: [],
    lastAppliedSeq: 0,
    lastShotAt: -Infinity,
    immunityUntil: now + PLAYER.IMMUNITY_SEC * 1000,

    joinedAt: now,
    lastHeardAt: now,
    pendingRespawnAt: null,
  };
}

/** Build a wire DTO from an internal `ServerPlayer`. */
export function toPlayerStateDto(p: ServerPlayer): PlayerStateDto {
  return {
    id: p.id,
    position: { x: p.position.x, y: p.position.y, z: p.position.z },
    velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z },
    orientation: { x: p.orientation.x, y: p.orientation.y, z: p.orientation.z, w: p.orientation.w },
    hp: p.hp,
    lives: p.lives,
    alive: p.alive,
    turbo: p.turbo,
  };
}

/**
 * Reset a player to a fresh spawn pose with full lives and immunity.
 * Mirrors `frontend/src/game/gameState.ts:resetForRespawn` but with the
 * server-supplied spawn point (not a hard-coded `(0, 80, 0)`).
 */
export function resetPlayerForRespawn(
  p: ServerPlayer,
  spawn: { position: Vec3; orientation: Vec4 },
  now: number
): void {
  p.position.x = spawn.position.x;
  p.position.y = spawn.position.y;
  p.position.z = spawn.position.z;
  p.velocity.x = 0;
  p.velocity.y = 0;
  p.velocity.z = 0;
  p.orientation.x = spawn.orientation.x;
  p.orientation.y = spawn.orientation.y;
  p.orientation.z = spawn.orientation.z;
  p.orientation.w = spawn.orientation.w;
  p.turbo = false;
  p.dodgeActive = false;
  p.dodgeAccumulator = 0;
  p.dodgeCooldownLeft = 0;
  p.dodgeRoll = 0;
  p.hp = PLAYER.MAX_LIVES;
  p.lives = PLAYER.MAX_LIVES;
  p.alive = true;
  p.immunityUntil = now + PLAYER.IMMUNITY_SEC * 1000;
  p.pendingRespawnAt = null;
}

/** Server-side world clamp — same axes as the shared `applyPlaneInput` clamp. */
export function clampPlayerToWorld(p: ServerPlayer): void {
  if (p.position.y < PLANE.WORLD_FLOOR_Y) p.position.y = PLANE.WORLD_FLOOR_Y;
  if (p.position.y > PLANE.WORLD_CEIL_Y) p.position.y = PLANE.WORLD_CEIL_Y;
  const half = PLANE.WORLD_HALF_SIZE;
  if (p.position.x < -half) p.position.x = -half;
  if (p.position.x > half) p.position.x = half;
  if (p.position.z < -half) p.position.z = -half;
  if (p.position.z > half) p.position.z = half;
}
