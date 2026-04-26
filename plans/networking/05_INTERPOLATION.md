# Networking — 05 — Remote Entity Interpolation

Snapshots arrive at 20 Hz. Rendering at 60 Hz against the most recent snapshot makes remote planes teleport every 50 ms — three render frames sit on the same data, the next frame jumps. The standard fix is **buffered interpolation**: keep a short history of snapshots, render the world at a *delayed* timeline, and interpolate between the two snapshots that bracket that delayed time.

This is a direct 3D port of Garama's [`interpolateRemotePlayers.ts`](../../../Garama/frontend/src/game/net/interpolateRemotePlayers.ts) — same algorithm, same buffer model, same extrapolation cap. Differences:

- We `slerp` quaternions in addition to lerping `Vec3` positions.
- We extend the same model to **projectiles**, not just players.
- The buffer key is `serverTimeMs` from `SnapshotPayload`, not the per-snapshot `serverTime` field, but the structure is identical.

## What gets interpolated

| Entity | Interpolated? | Why |
|--------|---------------|-----|
| Local player | **No.** | Predicted client-side ([`04_CLIENT_PREDICTION.md`](04_CLIENT_PREDICTION.md)). |
| Remote players | **Yes.** | Smooth motion + orientation. |
| Projectiles (any owner) | **Yes**, except locally fired ones (which stay at their predicted spawn until the spawn event lands; see below). | They move at constant velocity; lerp + extrapolate is exact. |
| Particles, HUD, camera | **No.** | Pure local concerns. |
| Score / HP / lives flags | **No.** | Stepwise; jump on snapshot arrival. |

## The render timeline

```
clientTime  ──────────────────────────────────────────────────►
                                  │
                  serverTimeNow() ─┤   (clock-sync output)
                                  │
                                  ┌─ INTERP_DELAY_MS ─┐
                                  ▼                    ▼
            serverTimeNow() − INTERP_DELAY_MS ←── render time
                                  │
                                  ▼
            ────────●───────●───────●──◇──●───────●───────●──── snapshot timeline
                              ▲       ▲
                              │       │
                            S(prev) S(next)         ◇ = render time falls between these two

            position := lerp(S(prev).pos, S(next).pos, t)
            orientation := slerp(S(prev).quat, S(next).quat, t)
            t = (renderTime − S(prev).serverTimeMs) / (S(next).serverTimeMs − S(prev).serverTimeMs)
```

`INTERP_DELAY_MS = 100` from [`00_OVERVIEW.md`](00_OVERVIEW.md). Two snapshots' worth of buffer (snapshot rate is 50 ms) plus a margin for jitter. If a snapshot is dropped, we still have one in the buffer to interpolate against.

## Per-remote-entity buffer

```ts
// frontend/src/net/interpolation.ts
export interface RemotePlayerSample {
  serverTimeMs: number;
  position:     Vec3;
  velocity:     Vec3;
  orientation:  Vec4;
  // turbo / hp / lives / alive copied as a non-interpolated stepwise value;
  // applied at the moment a snapshot lands, not interpolated.
}

export interface RemoteProjectileSample {
  serverTimeMs: number;
  position:     Vec3;
  velocity:     Vec3;
  ttl:          number;
}

// Per-entity ring buffer. Bounded.
const remotePlayerBuffers:     Map<string, RemotePlayerSample[]>     = new Map();
const remoteProjectileBuffers: Map<number, RemoteProjectileSample[]> = new Map();

const MAX_SAMPLES = NET.REMOTE_SNAPSHOT_BUFFER_MAX;   // 60 (= 3 s @ 20 Hz)
```

## Snapshot ingestion

When a `snapshot` event arrives:

```ts
function ingestSnapshot(snap: SnapshotPayload, net: NetState): void {
  net.lastSnapshotServerTimeMs = snap.serverTimeMs;
  net.lastSnapshotClientRecvMs = performance.now();

  // PLAYERS
  const seenPlayerIds = new Set<string>();
  for (const sp of snap.players) {
    seenPlayerIds.add(sp.id);
    if (sp.id === state.localPlayerId) continue;       // local plane uses prediction

    let buf = remotePlayerBuffers.get(sp.id);
    if (!buf) { buf = []; remotePlayerBuffers.set(sp.id, buf); }
    buf.push({
      serverTimeMs: snap.serverTimeMs,
      position:     { ...sp.position },
      velocity:     { ...sp.velocity },
      orientation:  { ...sp.orientation },
    });
    if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);

    // Stepwise scalars: latch immediately, no interpolation.
    const remote = state.remotePlayers.get(sp.id);
    if (remote) {
      remote.hp     = sp.hp;
      remote.lives  = sp.lives;
      remote.alive  = sp.alive;
      remote.turbo  = sp.turbo;
    }
  }
  // Drop buffers for players the snapshot no longer mentions (handled via
  // playerLeft event normally, but defensive).
  for (const id of remotePlayerBuffers.keys()) {
    if (!seenPlayerIds.has(id)) remotePlayerBuffers.delete(id);
  }

  // PROJECTILES — same shape, keyed by numeric id.
  const seenProjIds = new Set<number>();
  for (const sp of snap.projectiles) {
    seenProjIds.add(sp.id);
    let buf = remoteProjectileBuffers.get(sp.id);
    if (!buf) { buf = []; remoteProjectileBuffers.set(sp.id, buf); }
    buf.push({
      serverTimeMs: snap.serverTimeMs,
      position:     { ...sp.position },
      velocity:     { ...sp.velocity },
      ttl:          sp.ttl,
    });
    if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
  }
  // Despawn handling
  for (const ev of snap.events.despawns) {
    remoteProjectileBuffers.delete(ev.projectileId);
    // Cosmetic: spawn a hit puff at ev.position via the existing particleSystem.
  }
}
```

## Per-frame interpolation step (every render frame, not every fixed tick)

```ts
function interpolateRemotes(net: NetState): void {
  const renderTime = serverTimeNow(net) - NET.INTERP_DELAY_MS;   // 100

  // PLAYERS
  for (const [id, buf] of remotePlayerBuffers) {
    if (buf.length === 0) continue;
    const remote = state.remotePlayers.get(id);
    if (!remote || !remote.alive) continue;             // dead bodies don't move

    // 1. Trim. Drop samples >2 old to keep the window tight (Garama does this).
    while (buf.length >= 3 && buf[1].serverTimeMs <= renderTime) buf.shift();

    const s0 = buf[0];
    const s1 = buf[1];

    // 2. Standard interp case: renderTime sits between s0 and s1.
    if (s1 && s0.serverTimeMs <= renderTime && renderTime <= s1.serverTimeMs) {
      const span = s1.serverTimeMs - s0.serverTimeMs;
      const t    = span > 0 ? (renderTime - s0.serverTimeMs) / span : 0;
      vec3Lerp(remote.position,    s0.position,    s1.position,    t);
      vec3Lerp(remote.velocity,    s0.velocity,    s1.velocity,    t);
      quatSlerp(remote.orientation, s0.orientation, s1.orientation, t);
      continue;
    }

    // 3. We've outrun the buffer. Extrapolate using last+prev velocity if we
    //    have two samples; otherwise hold last position.
    const last = buf[buf.length - 1];
    const prev = buf[buf.length - 2];
    if (last && prev && renderTime > last.serverTimeMs) {
      const aheadMs = clamp(0, renderTime - last.serverTimeMs, NET.EXTRAPOLATION_CAP_MS);   // 150
      const ahead   = aheadMs / 1000;
      remote.position.x = last.position.x + last.velocity.x * ahead;
      remote.position.y = last.position.y + last.velocity.y * ahead;
      remote.position.z = last.position.z + last.velocity.z * ahead;
      // Orientation: slerp from prev to last, projected ahead — but in v1 we
      // freeze orientation at `last.orientation` (cheaper, looks fine for ≤150 ms).
      copyQuat(remote.orientation, last.orientation);
    } else if (last) {
      copyVec3(remote.position,    last.position);
      copyQuat (remote.orientation, last.orientation);
    }
  }

  // PROJECTILES — same shape but using the velocity field for extrapolation
  // (we know they don't change direction).
  for (const [id, buf] of remoteProjectileBuffers) {
    if (buf.length === 0) continue;
    const proj = state.remoteProjectiles.get(id);
    if (!proj) continue;

    while (buf.length >= 3 && buf[1].serverTimeMs <= renderTime) buf.shift();

    const s0 = buf[0];
    const s1 = buf[1];
    if (s1 && s0.serverTimeMs <= renderTime && renderTime <= s1.serverTimeMs) {
      const span = s1.serverTimeMs - s0.serverTimeMs;
      const t    = span > 0 ? (renderTime - s0.serverTimeMs) / span : 0;
      vec3Lerp(proj.position, s0.position, s1.position, t);
      continue;
    }
    const last = buf[buf.length - 1];
    if (last) {
      const aheadMs = clamp(0, renderTime - last.serverTimeMs, NET.EXTRAPOLATION_CAP_MS);
      const ahead   = aheadMs / 1000;
      proj.position.x = last.position.x + last.velocity.x * ahead;
      proj.position.y = last.position.y + last.velocity.y * ahead;
      proj.position.z = last.position.z + last.velocity.z * ahead;
    }
  }
}
```

`vec3Lerp`, `quatSlerp`, `clamp`, etc. are tiny helpers; the project already has [`utils/math.ts`](../../frontend/src/utils/math.ts) for `damp`/`clamp`. `THREE.Quaternion.slerp` does the slerp natively when we touch the actual remote-plane mesh. The interpolation system writes into the data structure (`PlayerState`-like), and the existing [`applyPose`](../../frontend/src/entities/plane.ts:68) renders it.

## Extrapolation cap rationale

`NET.EXTRAPOLATION_CAP_MS = 150 ms`. Once the buffer is empty for longer than that, extrapolating further is more wrong than just freezing — the plane could be doing anything. We clamp the extrapolation to 150 ms past the last sample. This produces:

- 0–150 ms behind: smooth motion (extrapolated by `velocity`).
- 150–500 ms behind: frozen at last known position (visible "stutter" — better than wrong-direction skating).
- > 500 ms behind: probably dropped from the room; `playerLeft` arrives shortly and removes the entity altogether.

## Despawn handling

Two paths:

1. **Soft despawn** (player still in room, projectile expired). The `events.despawns` array lists projectile ids. Drop the buffer, drop the visual (particle puff via [`spawnBurst`](../../frontend/src/game/systems/particleSystem.ts) — `'expired'` is silent, the others spawn the appropriate burst kind). The `position` field on the despawn event tells us where to spawn the FX, which is more accurate than reading "wherever interpolation left it" because the bullet may have collided between snapshots.
2. **Hard despawn** (player left). `playerLeft` event arrives → drop the remote player entity, drop the buffer. Any of their projectiles in flight already exist as separate `projectileBuffers` entries with `ownerId === <gone>` and continue to fly+interpolate normally until their own despawn.

## A note on the local player's projectiles in v1

Per [`04_CLIENT_PREDICTION.md`](04_CLIENT_PREDICTION.md), v1 does **not** spawn a predicted local projectile on click. The local player's bullet first appears when its `events.spawns` arrives in a snapshot, then plays through the same interpolation buffer as everyone else's. There is therefore one path for projectile rendering — simpler, less buggy. The cost is a visible 60–150 ms "click-to-bullet" lag.

(v2: spawn a local-only ghost projectile on click; merge with the server-spawned one when `events.spawns` arrives. Garama's analogue is its `attack_vfx` — also entirely server-driven. We're choosing the same trade-off.)

## Worked example: 2 players, 1 bullet, 100 ms RTT

```
t (server, ms) │ event
───────────────┼────────────────────────────────────────────────────────────────
   0           │  Player B at (0,80,0)                                  serverTime=0
  50           │  snapshot 1 emitted — players: [A, B@0,80,0]
 100           │  Player B moves forward to (0,80,5) (5 m at 60 m/s)
 100           │  snapshot 2 emitted — players: [A, B@0,80,5]
 150           │  Player B at (0,80,10)                                  --- A's view ---
                                                                        clientTime ≈ 50 ms
                                                                        net.clockOffsetMs = -50 ms (B's serverTime - A's clientTime)
                                                                        renderTime = serverTimeNow() - 100 = (50 + (-50)) - 100 = -100 ms
                                                                        ... no samples yet, A sees the WELCOME pose for B
 200           │  snapshot 3 emitted — players: [A, B@0,80,15]
 250           │  A's clientTime ≈ 200, serverTimeNow() ≈ 250, renderTime = 150
                                                                        buffer for B = [s1@50,s2@100,s3@200]
                                                                        renderTime (150) is between s2 (100) and s3 (200)
                                                                        t = (150-100) / (200-100) = 0.5
                                                                        B rendered at (0,80, lerp(5, 15, 0.5)) = (0,80,10)  ← matches truth
```

A renders B at where B *was* on the server 100 ms ago. That's the cost of `INTERP_DELAY_MS` — and the price for never seeing B teleport.

## Tunables (summary)

```ts
NET.INTERP_DELAY_MS               = 100;
NET.EXTRAPOLATION_CAP_MS          = 150;
NET.REMOTE_SNAPSHOT_BUFFER_MAX    = 60;
```

## File responsibilities

```
frontend/src/net/interpolation.ts
  - remotePlayerBuffers, remoteProjectileBuffers
  - ingestSnapshot(snap, net) — called by netSystem on receive
  - interpolateRemotes(net)   — called by gameLoop in render path
```
