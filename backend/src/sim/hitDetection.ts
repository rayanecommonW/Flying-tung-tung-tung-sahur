/**
 * v1 hit detection — naïve "current server-tick" sphere-vs-sphere.
 *
 * For every alive projectile, scan every alive non-owner player and check
 * `sqDist <= (rPlayer + rProj)²`. On overlap: decrement target lives,
 * push events into the buffer, despawn the projectile, schedule respawn
 * if lives reached zero.
 *
 * No lag compensation — that's filed under v2 in
 * `plans/networking/06_HIT_REGISTRATION.md`.
 */

import { DEATH, NET } from '@flying-tung-tung/shared';
import type {
  HitEventDto,
  DeathEventDto,
  DespawnEventDto,
  RespawnEventDto,
  SpawnEventDto,
} from '@flying-tung-tung/shared';
import type { ServerPlayer } from './player';
import { resetPlayerForRespawn } from './player';
import type { ServerProjectile } from './projectile';
import type { SpawnPicker } from './spawn';

export interface EventsBuffer {
  spawns: SpawnEventDto[];
  despawns: DespawnEventDto[];
  hits: HitEventDto[];
  deaths: DeathEventDto[];
  respawns: RespawnEventDto[];
}

export function freshEventsBuffer(): EventsBuffer {
  return {
    spawns: [],
    despawns: [],
    hits: [],
    deaths: [],
    respawns: [],
  };
}

/** Move the buffered events into a fresh frozen object and reset the buffer. */
export function drainEventsBuffer(buf: EventsBuffer): EventsBuffer {
  const out: EventsBuffer = {
    spawns: buf.spawns,
    despawns: buf.despawns,
    hits: buf.hits,
    deaths: buf.deaths,
    respawns: buf.respawns,
  };
  buf.spawns = [];
  buf.despawns = [];
  buf.hits = [];
  buf.deaths = [];
  buf.respawns = [];
  return out;
}

const HIT_RADIUS_SQ =
  (NET.HIT_RADIUS_PLAYER + NET.HIT_RADIUS_PROJECTILE) *
  (NET.HIT_RADIUS_PLAYER + NET.HIT_RADIUS_PROJECTILE);

/**
 * Single-pass projectile-vs-player collision. Mutates lives/alive on the
 * affected players, marks projectiles `alive=false`, pushes events.
 *
 * Caller (`Room`) is expected to remove dead projectiles from its `Map`
 * after this returns; we leave them in the map with `alive=false` so the
 * outer integrate loop also sees them.
 */
export function detectProjectileVsPlayerHits(
  projectiles: Map<number, ServerProjectile>,
  players: Map<string, ServerPlayer>,
  now: number,
  events: EventsBuffer,
  tick: number
): void {
  for (const p of projectiles.values()) {
    if (!p.alive) continue;
    for (const target of players.values()) {
      if (!target.alive) continue;
      if (target.id === p.ownerId) continue;
      if (now < target.immunityUntil) continue;

      const dx = p.position.x - target.position.x;
      const dy = p.position.y - target.position.y;
      const dz = p.position.z - target.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > HIT_RADIUS_SQ) continue;

      // === Hit ===
      target.lives = Math.max(0, target.lives - NET.PROJECTILE_DAMAGE);
      target.hp = target.lives;
      target.immunityUntil = now + 200; // 200 ms post-hit grace

      events.hits.push({
        tick,
        victimId: target.id,
        attackerId: p.ownerId,
        projectileId: p.id,
        position: { x: p.position.x, y: p.position.y, z: p.position.z },
        livesLeft: target.lives,
      });

      p.alive = false;
      events.despawns.push({
        tick,
        projectileId: p.id,
        reason: 'hit-player',
        position: { x: p.position.x, y: p.position.y, z: p.position.z },
      });

      if (target.lives <= 0) {
        target.alive = false;
        target.pendingRespawnAt = now + DEATH.RESPAWN_DELAY_SEC * 1000;
        events.deaths.push({
          tick,
          victimId: target.id,
          attackerId: p.ownerId,
          position: { x: target.position.x, y: target.position.y, z: target.position.z },
        });
      }
      break; // one bullet, one victim
    }
  }
}

/**
 * Apply the elapsed-respawn-timer pass: any dead player whose
 * `pendingRespawnAt` is in the past gets reset and pushed as a respawn
 * event. Caller supplies the spawn picker (so we don't reach into Room
 * internals).
 */
export function resolveDeathsAndRespawns(
  players: Map<string, ServerPlayer>,
  now: number,
  spawnPicker: SpawnPicker,
  events: EventsBuffer,
  tick: number
): void {
  for (const player of players.values()) {
    if (player.alive) continue;
    if (player.pendingRespawnAt === null) continue;
    if (now < player.pendingRespawnAt) continue;

    const spawn = spawnPicker.choose(players, player.id);
    resetPlayerForRespawn(player, spawn, now);

    events.respawns.push({
      tick,
      playerId: player.id,
      position: { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z },
      orientation: {
        x: spawn.orientation.x,
        y: spawn.orientation.y,
        z: spawn.orientation.z,
        w: spawn.orientation.w,
      },
    });
  }
}
