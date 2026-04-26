/**
 * Buffered remote-entity interpolation. 3D port of Garama's
 * `interpolateRemotePlayers.ts`. Renders remote planes + projectiles at
 * `serverTimeNow() − INTERP_DELAY_MS` to hide the 50 ms snapshot stride.
 *
 * Two ring buffers — one keyed by player id (string), one keyed by
 * projectile id (number). We push samples on snapshot ingest and consume
 * them every render frame.
 */

import { NET, quatSlerp, vec3Lerp, quatCopy, vec3Copy } from '@flying-tung-tung/shared';
import type { SnapshotPayload, Vec3, Vec4 } from '@flying-tung-tung/shared';

import type { NetState } from './netState';
import { serverTimeNow } from './netState';

const MAX_SAMPLES = NET.REMOTE_SNAPSHOT_BUFFER_MAX;

/** Externally-visible interpolated remote-player state (mutated in place). */
export interface RemotePlayerView {
  id: string;
  position: Vec3;
  velocity: Vec3;
  orientation: Vec4;
  hp: number;
  lives: number;
  alive: boolean;
  turbo: boolean;
}

/** Externally-visible interpolated remote-projectile state. */
export interface RemoteProjectileView {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  ttl: number;
  alive: boolean;
}

export interface InterpolatedSets {
  remotePlayers: Map<string, RemotePlayerView>;
  remoteProjectiles: Map<number, RemoteProjectileView>;
}

/** Push the snapshot's per-entity state into the interpolation buffers. */
export function ingestSnapshot(
  snap: SnapshotPayload,
  net: NetState,
  views: InterpolatedSets
): void {
  net.lastSnapshotServerTimeMs = snap.serverTimeMs;
  net.lastSnapshotClientRecvMs = performance.now();

  // === Players ===
  const seenIds = new Set<string>();
  for (const sp of snap.players) {
    seenIds.add(sp.id);
    if (sp.id === net.selfId) continue; // local plane is predicted

    let buf = net.remotePlayerBuffers.get(sp.id);
    if (!buf) {
      buf = [];
      net.remotePlayerBuffers.set(sp.id, buf);
    }
    buf.push({
      serverTimeMs: snap.serverTimeMs,
      position: { ...sp.position },
      velocity: { ...sp.velocity },
      orientation: { ...sp.orientation },
    });
    if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);

    // Stepwise scalars: latch immediately, no interpolation.
    let view = views.remotePlayers.get(sp.id);
    if (!view) {
      view = {
        id: sp.id,
        position: { ...sp.position },
        velocity: { ...sp.velocity },
        orientation: { ...sp.orientation },
        hp: sp.hp,
        lives: sp.lives,
        alive: sp.alive,
        turbo: sp.turbo,
      };
      views.remotePlayers.set(sp.id, view);
    } else {
      view.hp = sp.hp;
      view.lives = sp.lives;
      view.alive = sp.alive;
      view.turbo = sp.turbo;
    }
  }
  // Clean up buffers / views for players the snapshot no longer mentions.
  for (const id of [...net.remotePlayerBuffers.keys()]) {
    if (!seenIds.has(id) && id !== net.selfId) {
      net.remotePlayerBuffers.delete(id);
    }
  }

  // === Projectiles ===
  const seenProj = new Set<number>();
  for (const sp of snap.projectiles) {
    seenProj.add(sp.id);
    let buf = net.remoteProjectileBuffers.get(sp.id);
    if (!buf) {
      buf = [];
      net.remoteProjectileBuffers.set(sp.id, buf);
    }
    buf.push({
      serverTimeMs: snap.serverTimeMs,
      position: { ...sp.position },
      velocity: { ...sp.velocity },
      ttl: sp.ttl,
    });
    if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);

    let view = views.remoteProjectiles.get(sp.id);
    if (!view) {
      view = {
        id: sp.id,
        ownerId: sp.ownerId,
        position: { ...sp.position },
        velocity: { ...sp.velocity },
        ttl: sp.ttl,
        alive: true,
      };
      views.remoteProjectiles.set(sp.id, view);
    } else {
      view.ttl = sp.ttl;
      view.alive = true;
    }
  }
  // Despawn handling — events.despawns covers both expired + hit cases.
  for (const ev of snap.events.despawns) {
    net.remoteProjectileBuffers.delete(ev.projectileId);
    const view = views.remoteProjectiles.get(ev.projectileId);
    if (view) view.alive = false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Find the bracketing samples for `renderTime` in `buf`. Returns indices
 * `[i0, i1]` with `buf[i0].serverTimeMs <= renderTime <= buf[i1].serverTimeMs`,
 * or `null` when we have to extrapolate (renderTime past last sample).
 */
function bracket(
  buf: { serverTimeMs: number }[],
  renderTime: number
): [number, number] | null {
  if (buf.length === 0) return null;
  // Find the first sample at or after renderTime.
  let i1 = 0;
  while (i1 < buf.length && buf[i1]!.serverTimeMs < renderTime) i1++;
  if (i1 === 0) {
    // renderTime is before the first sample — pin to the first.
    return [0, 0];
  }
  if (i1 >= buf.length) return null;
  return [i1 - 1, i1];
}

/** Per-render-frame: write interpolated pose into each remote view. */
export function interpolateRemotes(net: NetState, views: InterpolatedSets): void {
  const renderTime = serverTimeNow(net) - NET.INTERP_DELAY_MS;

  // === Players ===
  for (const [id, buf] of net.remotePlayerBuffers) {
    if (buf.length === 0) continue;
    const view = views.remotePlayers.get(id);
    if (!view) continue;

    // Trim: keep at most 2 samples in the past besides the bracketing pair.
    while (buf.length >= 4 && buf[1]!.serverTimeMs <= renderTime) buf.shift();

    const br = bracket(buf, renderTime);
    if (br) {
      const [i0, i1] = br;
      const s0 = buf[i0]!;
      const s1 = buf[i1]!;
      const span = s1.serverTimeMs - s0.serverTimeMs;
      const t = span > 0 ? clamp((renderTime - s0.serverTimeMs) / span, 0, 1) : 0;
      vec3Lerp(view.position, s0.position, s1.position, t);
      vec3Lerp(view.velocity, s0.velocity, s1.velocity, t);
      quatSlerp(view.orientation, s0.orientation, s1.orientation, t);
      continue;
    }

    // Extrapolate up to EXTRAPOLATION_CAP_MS past last sample.
    const last = buf[buf.length - 1]!;
    const aheadMs = clamp(renderTime - last.serverTimeMs, 0, NET.EXTRAPOLATION_CAP_MS);
    const ahead = aheadMs / 1000;
    view.position.x = last.position.x + last.velocity.x * ahead;
    view.position.y = last.position.y + last.velocity.y * ahead;
    view.position.z = last.position.z + last.velocity.z * ahead;
    quatCopy(view.orientation, last.orientation);
    vec3Copy(view.velocity, last.velocity);
  }

  // === Projectiles ===
  for (const [id, buf] of net.remoteProjectileBuffers) {
    if (buf.length === 0) continue;
    const view = views.remoteProjectiles.get(id);
    if (!view || !view.alive) continue;

    while (buf.length >= 4 && buf[1]!.serverTimeMs <= renderTime) buf.shift();

    const br = bracket(buf, renderTime);
    if (br) {
      const [i0, i1] = br;
      const s0 = buf[i0]!;
      const s1 = buf[i1]!;
      const span = s1.serverTimeMs - s0.serverTimeMs;
      const t = span > 0 ? clamp((renderTime - s0.serverTimeMs) / span, 0, 1) : 0;
      vec3Lerp(view.position, s0.position, s1.position, t);
      continue;
    }
    const last = buf[buf.length - 1]!;
    const aheadMs = clamp(renderTime - last.serverTimeMs, 0, NET.EXTRAPOLATION_CAP_MS);
    const ahead = aheadMs / 1000;
    view.position.x = last.position.x + last.velocity.x * ahead;
    view.position.y = last.position.y + last.velocity.y * ahead;
    view.position.z = last.position.z + last.velocity.z * ahead;
  }

  // Drop projectile views whose alive flag dropped one snapshot ago.
  for (const [id, view] of views.remoteProjectiles) {
    if (!view.alive) views.remoteProjectiles.delete(id);
  }
}
