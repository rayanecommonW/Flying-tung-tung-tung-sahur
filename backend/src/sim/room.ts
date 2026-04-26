/**
 * The single global room. Owns players, projectiles, the 30 Hz tick loop,
 * the 20 Hz snapshot accumulator, the events buffer, and the spawn picker.
 *
 * Drift-compensated tick: we self-schedule via `setTimeout` against
 * `nextTickAt += SERVER_TICK_MS`, so wall-clock jitter doesn't shift our
 * sim-time forward. If we fall more than ~5 ticks behind we resync rather
 * than spiral.
 */

import type { Server } from 'socket.io';
import {
  EVENTS,
  NET,
  PROJECTILE,
  applyPlaneInput,
  buildIdleInput,
  fromInputPayload,
  integrateProjectile,
} from '@flying-tung-tung/shared';
import type { SnapshotPayload, InputPayload } from '@flying-tung-tung/shared';

import type { ServerPlayer } from './player';
import { clampPlayerToWorld, toPlayerStateDto } from './player';
import type { ServerProjectile } from './projectile';
import { toProjectileStateDto, tryCreateProjectile } from './projectile';
import {
  detectProjectileVsPlayerHits,
  drainEventsBuffer,
  freshEventsBuffer,
  resolveDeathsAndRespawns,
} from './hitDetection';
import type { EventsBuffer } from './hitDetection';
import { SpawnPicker } from './spawn';
import { getServerTimeMs } from '../utils/clock';

export class Room {
  static readonly ID = 'global';
  static readonly MAX_PLAYERS = NET.MAX_PLAYERS_PER_ROOM;

  readonly tickMs = NET.SERVER_TICK_MS;
  readonly snapshotMs = NET.SNAPSHOT_MS;

  readonly players = new Map<string, ServerPlayer>();
  readonly projectiles = new Map<number, ServerProjectile>();
  readonly spawnPicker = new SpawnPicker();
  readonly eventsBuffer: EventsBuffer = freshEventsBuffer();

  tick = 0;
  private snapshotAcc = 0;
  private nextTickAt = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly io: Server,
    public readonly seed: number
  ) {}

  isFull(): boolean {
    return this.players.size >= Room.MAX_PLAYERS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = performance.now();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ===== Tick loop =====================================================

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.timer = setTimeout(() => this.tickOnce(), delay);
  }

  private tickOnce(): void {
    if (!this.running) return;
    try {
      this.simulateOneTick();
    } catch (err) {
      console.error('[room] tick error:', err);
    }

    this.tick++;
    this.nextTickAt += this.tickMs;

    // Drift drop: if we're more than 5 ticks behind real time, resync.
    const lag = performance.now() - this.nextTickAt;
    if (lag > this.tickMs * 5) {
      console.warn(`[room] tick fell behind by ${lag.toFixed(1)}ms; resyncing nextTickAt`);
      this.nextTickAt = performance.now() + this.tickMs;
    }
    this.scheduleNext();
  }

  private simulateOneTick(): void {
    const now = getServerTimeMs();
    const dt = this.tickMs / 1000;

    // 1+2. Drain inputs & apply physics for each player.
    for (const player of this.players.values()) {
      const queue = player.inputQueue;
      player.inputQueue = [];

      // Filter to inputs ahead of lastAppliedSeq.
      const fresh = queue.filter((i) => i.seq > player.lastAppliedSeq);

      if (fresh.length === 0) {
        if (player.alive) {
          applyPlaneInput(player, buildIdleInput(player.turbo), dt);
        }
      } else {
        for (const inp of fresh) {
          if (player.alive) {
            applyPlaneInput(player, fromInputPayload(inp), inp.dt);
          }
          player.lastAppliedSeq = inp.seq;
          if (inp.fire && player.alive) {
            this.tryFire(player, now);
          }
        }
      }
    }

    // 3+4. Integrate projectiles & despawn aged-out ones.
    for (const p of this.projectiles.values()) {
      if (!p.alive) continue;
      integrateProjectile(p, dt);
      if (p.ttl <= 0) {
        p.alive = false;
        this.eventsBuffer.despawns.push({
          tick: this.tick,
          projectileId: p.id,
          reason: 'expired',
          position: { x: p.position.x, y: p.position.y, z: p.position.z },
        });
        continue;
      }
      // Ground despawn (server uses y<=0 just like the client).
      if (p.position.y <= 0) {
        p.alive = false;
        this.eventsBuffer.despawns.push({
          tick: this.tick,
          projectileId: p.id,
          reason: 'hit-ground',
          position: { x: p.position.x, y: 0.05, z: p.position.z },
        });
        continue;
      }
      // Crude OOB check using the world clamp radius (sphere).
      const ox = p.position.x;
      const oy = p.position.y;
      const oz = p.position.z;
      const r2 = NET.WORLD_CLAMP_RADIUS * NET.WORLD_CLAMP_RADIUS;
      if (ox * ox + oy * oy + oz * oz > r2) {
        p.alive = false;
        this.eventsBuffer.despawns.push({
          tick: this.tick,
          projectileId: p.id,
          reason: 'out-of-bounds',
          position: { x: p.position.x, y: p.position.y, z: p.position.z },
        });
      }
    }

    // 5. Hits.
    detectProjectileVsPlayerHits(
      this.projectiles,
      this.players,
      now,
      this.eventsBuffer,
      this.tick
    );

    // 6+7. Deaths/respawns.
    resolveDeathsAndRespawns(this.players, now, this.spawnPicker, this.eventsBuffer, this.tick);

    // 8. Bounds clamp + remove dead projectiles.
    for (const player of this.players.values()) clampPlayerToWorld(player);
    for (const id of [...this.projectiles.keys()]) {
      const p = this.projectiles.get(id);
      if (p && !p.alive) this.projectiles.delete(id);
    }

    // Heartbeat-timeout: kick any player we haven't heard from in too long.
    for (const player of this.players.values()) {
      if (now - player.lastHeardAt > NET.HEARTBEAT_TIMEOUT_MS) {
        console.warn(
          `[room] heartbeat timeout for id=${player.id} (${now - player.lastHeardAt}ms silent)`
        );
        try {
          player.socket.disconnect(true);
        } catch {
          /* ignore — disconnect handler removes them anyway */
        }
      }
    }

    // 9. Snapshot accumulator.
    this.snapshotAcc += this.tickMs;
    if (this.snapshotAcc >= this.snapshotMs) {
      this.emitSnapshot(now);
      this.snapshotAcc -= this.snapshotMs;
      // If we've drifted far, reset to 0 to avoid burst-emitting snapshots.
      if (this.snapshotAcc > this.snapshotMs) this.snapshotAcc = 0;
    }
  }

  // ===== Public input plumbing ==========================================

  /**
   * Append an input to the named player's queue. Called from
   * `socketHandlers.handleInput`.
   */
  enqueueInput(playerId: string, input: InputPayload, now: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (input.seq <= player.lastAppliedSeq) return; // dup or stale
    // Sanity ceiling — design says 64 buffered inputs == >2 s of backlog.
    if (player.inputQueue.length >= 64) {
      // Drop the oldest, keep the newest.
      player.inputQueue.shift();
    }
    player.inputQueue.push(input);
    player.lastHeardAt = now;
  }

  /** Server-spawn a projectile from the given player. Pushes to map + events. */
  tryFire(player: ServerPlayer, now: number): void {
    const proj = tryCreateProjectile(player, this.tick, now);
    if (!proj) return;
    this.projectiles.set(proj.id, proj);
    this.eventsBuffer.spawns.push({
      tick: this.tick,
      projectileId: proj.id,
      ownerId: proj.ownerId,
      position: { x: proj.position.x, y: proj.position.y, z: proj.position.z },
      velocity: { x: proj.velocity.x, y: proj.velocity.y, z: proj.velocity.z },
    });
  }

  // ===== Snapshot =======================================================

  private emitSnapshot(now: number): void {
    const players = [...this.players.values()].map(toPlayerStateDto);
    const projectiles = [...this.projectiles.values()]
      .filter((p) => p.alive)
      .map(toProjectileStateDto);
    const acks = [...this.players.values()].map((p) => ({ id: p.id, seq: p.lastAppliedSeq }));
    const events = drainEventsBuffer(this.eventsBuffer);

    const payload: SnapshotPayload = {
      tick: this.tick,
      serverTimeMs: now,
      players,
      projectiles,
      acks,
      events,
    };
    this.io.to(Room.ID).emit(EVENTS.SNAPSHOT, payload);
  }

  // Marker used by index.ts to know whether projectiles need stub config (PROJECTILE may be unused).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _projectileConstantsCheck = PROJECTILE.SPEED;
}
