/**
 * Server-side projectile. Spawned in `tryFire` from a player's nose +
 * forward, integrated each tick by the shared `integrateProjectile`,
 * despawned on hit / lifetime / ground.
 */

import type { ProjectileStateDto, Vec3 } from '@flying-tung-tung/shared';
import { PROJECTILE, NET, quatRotateVec } from '@flying-tung-tung/shared';
import type { ServerPlayer } from './player';
import { nextProjectileId } from '../utils/ids';

export interface ServerProjectile {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  spawnTick: number;
  /** Sim-seconds remaining before lifetime expiry. */
  ttl: number;
  alive: boolean;
}

const _forward: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Result-bearing fire attempt. Returns the new projectile or `null` if
 * cooldown blocked it / player is dead. Does NOT push into the room map —
 * caller (`Room.tryFire`) handles that and the events buffer.
 */
export function tryCreateProjectile(
  player: ServerPlayer,
  spawnTick: number,
  now: number
): ServerProjectile | null {
  if (!player.alive) return null;
  if (now - player.lastShotAt < PROJECTILE.COOLDOWN_SEC * 1000) return null;
  player.lastShotAt = now;

  // Spawn at the nose of the plane (player position + forward * NOSE_OFFSET).
  quatRotateVec(_forward, player.orientation, 0, 0, 1);
  const nx = player.position.x + _forward.x * NET.PLAYER_NOSE_OFFSET;
  const ny = player.position.y + _forward.y * NET.PLAYER_NOSE_OFFSET;
  const nz = player.position.z + _forward.z * NET.PLAYER_NOSE_OFFSET;

  return {
    id: nextProjectileId(),
    ownerId: player.id,
    position: { x: nx, y: ny, z: nz },
    velocity: {
      x: _forward.x * PROJECTILE.SPEED,
      y: _forward.y * PROJECTILE.SPEED,
      z: _forward.z * PROJECTILE.SPEED,
    },
    spawnTick,
    ttl: PROJECTILE.LIFETIME_SEC,
    alive: true,
  };
}

export function toProjectileStateDto(p: ServerProjectile): ProjectileStateDto {
  return {
    id: p.id,
    ownerId: p.ownerId,
    position: { x: p.position.x, y: p.position.y, z: p.position.z },
    velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z },
    ttl: p.ttl,
  };
}
