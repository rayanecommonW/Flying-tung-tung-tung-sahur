# Networking — 00 — Overview

## Why this folder exists

Flying Tung Tung shipped its single-player MVP per [`plans/08_ROADMAP.md`](../08_ROADMAP.md): the player flies, shoots, dodges, and crashes into a procedural city. The next milestone is **multiplayer PvP v1**: two or more players in the same world, seeing each other fly, shooting each other, and respawning when killed.

This folder is the design contract for that work. Every doc in here is *prescriptive* — it specifies how the v1 implementation should look so that the work in [`backend/src/`](../../backend/src/) and [`frontend/src/`](../../frontend/src/) is small, additive, and reversible.

The reference point is the 2D project at [`H:/Desktop/game dev/Garama`](../../../Garama/). We adopt its **stack** (Socket.IO over Bun + Hono, JSON snapshots, monorepo shared package) and its **clock-sync algorithm** wholesale, but we adapt the simulation, snapshot, and hit-registration models for 3D flight.

## v1 goals (what "done" looks like)

A player opens two browser tabs (or two laptops on the same LAN), each connects to `ws://localhost:3001`, and:

1. Both planes appear in each other's worlds at sane spawn points.
2. Both planes' positions, orientations (full 3D quaternion), and turbo state are smooth and not visibly jittery.
3. Either plane can shoot at the other; bullets are visible to both clients; hits register on the server; HP goes down; lives go to 0; the dead plane respawns.
4. Disconnects (close tab, kill server) clean up cleanly with no zombie planes.

## Explicit non-goals for v1

- **No matchmaking.** One global room per server process — see [`07_ROOMS_AND_LIFECYCLE.md`](07_ROOMS_AND_LIFECYCLE.md).
- **No persistence.** No accounts, no DB, no leaderboards. Everything lives in memory; restarting the server wipes all state.
- **No anti-cheat / no rate limiting beyond a basic input-rate cap.** Clients are trusted not to malicious-flood (we run on a LAN).
- **No voice chat, no text chat for v1.** [`01_PROTOCOL.md`](01_PROTOCOL.md) reserves the event name; implementation is deferred.
- **No binary encoding.** JSON over Socket.IO is good enough for ≤16 players; we explicitly mark this as a future optimization.
- **No full lag-compensated rewind hit detection.** [`06_HIT_REGISTRATION.md`](06_HIT_REGISTRATION.md) starts with "naïve current-server-state checks every tick" and lists rewind as future work.
- **No deterministic lockstep simulation.** We do classic client-server with prediction + interpolation, not Garama's "client sends position, server clamps" model. This is the main architectural divergence from Garama (see "Adapting Garama" below).

## Tech choices

| Layer | Choice | Justification |
|-------|--------|---------------|
| Transport | **Socket.IO 4.x** (`socket.io` server, `socket.io-client` browser) | Already in [`backend/package.json`](../../backend/package.json). Reconnection, room helpers (`socket.join`), automatic JSON, transport upgrade (long-poll → WebSocket) are free. Garama uses the same — we get to copy `clockSync.ts` directly. |
| Engine | `@socket.io/bun-engine` (already in deps) | Lets Socket.IO run inside `Bun.serve` next to the Hono `/health` route — no second port, no Express. |
| Runtime | **Bun** (server), **browser** (client) | Bun is already the workspace runtime ([`bun.lock`](../../bun.lock)); no new install. |
| Wire format | **JSON** | Simpler than `MessagePack` / flatbuffers; small for ≤16 players; quat = `{x,y,z,w}` is 4 numbers. |
| Server tick | **30 Hz** (33.33 ms) | Matches the simulation rate the client already uses ([`FIXED_DT`](../../packages/shared/src/config.ts:200) is 1/60 client; we deliberately run server at half — see "Why 30 Hz server" below). |
| Snapshot rate | **20 Hz** (every ~50 ms) | A snapshot is emitted on its own accumulator, not every tick. Halves bandwidth vs tick-rate snapshots while still giving the interpolator ≥5 samples in its 100 ms window. |
| Client render | **60 Hz** | Already runs at the browser's `requestAnimationFrame`. The fixed loop continues at 60 Hz; networking is layered on top. |
| Interp delay | **100 ms** | Standard "Source engine" value. Burns ~2 snapshots' worth of buffer. See [`05_INTERPOLATION.md`](05_INTERPOLATION.md). |
| Initial clock-sync samples | **5** | Task spec. Garama uses 8; we use 5 because v1 LAN play has near-zero RTT and the extra samples don't pay back the join-time cost. |

## Why an authoritative server (and why not "trust the client" like Garama)

Garama's server takes the client's claimed `(x, y)` position, clamps it to the map, pushes it out of polygons, and stores the result. That works for a 2D arena with no projectiles in flight and a melee-only attack model — there's nothing for a malicious client to lie about that the server can't fix at apply-time.

Flying Tung Tung has **projectiles in flight**, **3D collision**, and **lives that decrement on hit**. If the client decides where its own bullets are, anyone can write `velocity = 10000 * forward`, snap to any opponent, and one-shot them. We want PvP to be *minimally fair* without an arms race.

So the server is **authoritative** in the classic sense:

- The server keeps the canonical `PlayerState` and `ProjectileState` for every entity.
- Clients send **inputs**, not positions. The server runs the same plane physics ([`packages/shared/src/config.ts`](../../packages/shared/src/config.ts) tunables, plane controller logic) and produces snapshots.
- Clients **predict** their own plane locally so flight feels instant ([`04_CLIENT_PREDICTION.md`](04_CLIENT_PREDICTION.md)).
- Clients **interpolate** remote planes from snapshot history so they look smooth even at 20 Hz updates ([`05_INTERPOLATION.md`](05_INTERPOLATION.md)).
- The server runs hit detection. The client only paints the impact when the server says "hit".

This adds work over Garama but is the only honest way to do PvP shooters.

## Why 30 Hz server (and 60 Hz client render)

- **30 Hz simulation** is plenty for an arcade plane game. The plane's max angular velocity is ~1.6 rad/s ([`PLANE.MAX_TURN_PER_TICK`](../../packages/shared/src/config.ts:28) saturates well below); at 33 ms tick the largest per-tick orientation step is ~5°, well within what interpolation can hide.
- **60 Hz client render** keeps cameras + particles silky on monitors that refresh at 60+. The render path is decoupled from the physics tick, so it can read whatever interpolated state is current.
- Running the server at the same rate as the client (60 Hz) doubles CPU and bandwidth for no perceptible benefit on this game's feel target.

The local client *also* keeps running its 60 Hz fixed-step prediction loop. The server's 30 Hz is the **authoritative** rate that snapshots and reconciliation are measured in; the client's 60 Hz is the **predicted** rate that input feels like.

## What we adopt from Garama

- Socket.IO transport, single global room (`'match'`), `connect` → `join` → snapshot loop.
- Clock-sync algorithm: K-sample initial sync → median+σ outlier rejection → EMA maintenance → drift/RTT-spike resync. We literally rewrite [`Garama/frontend/src/game/net/clockSync.ts`](../../../Garama/frontend/src/game/net/clockSync.ts) with our event names and `K=5`.
- Per-remote snapshot ring buffer + render-time interpolation with extrapolation cap. The 2D `interpolateRemotePlayers.ts` becomes 3D quaternion + Vec3 interpolation in [`05_INTERPOLATION.md`](05_INTERPOLATION.md).
- `serverTick` + `serverTime` on every snapshot, EMA-smoothed `clockOffsetMs` and `smoothedRttMs` on the client.
- Monorepo shape: protocol in [`packages/shared`](../../packages/shared/), no client→server or backend→frontend imports.

## What we adapt for 3D / what we change

| Garama (2D) | Flying Tung Tung (3D) | Why |
|-------------|------------------------|-----|
| Client sends `position` 20×/s; server clamps. | Client sends **inputs** every fixed tick (60 Hz throttled to 30 Hz on send); server **simulates**. | Server-authoritative is required for projectiles + hit detection. |
| Player state = `{x, y}`. | Player state = `{position: Vec3, velocity: Vec3, orientation: Quat, hp, alive}`. | 3D + lives + alive flag. |
| No client-side prediction (movement is local). | **Full prediction + reconciliation** for the local plane. | Server-authoritative without prediction would feel awful — every input would be RTT-late. |
| 2D AABB hit registration. | Server-side projectile-vs-player **sphere-vs-sphere** every tick. | 3D + cheap; lag-comp deferred to v2. |
| Snapshot rate = tick rate (20 Hz tick = 20 Hz snapshot). | **Tick = 30 Hz, snapshot = 20 Hz** decoupled. | Saves bandwidth without coarsening the simulation. |
| 8 ping samples on connect. | **5** ping samples on connect. | LAN target + slightly faster join. |

## High-level data flow

```
                               ┌────────── server (Bun + Hono + Socket.IO) ──────────┐
                               │                                                     │
   client A          ─inputs→  │   inputQueue[A]  ─tick→  applyInput → physics →     │  ─snapshot→  client A (renders self predicted, B interpolated)
   (60 Hz predicted)           │   inputQueue[B]  ─tick→  applyInput → physics →     │
                               │   projectiles[]   ─tick→  integrate → hit detect →  │  ─snapshot→  client B (renders self predicted, A interpolated)
   client B          ─inputs→  │                                                     │
                               │   30 Hz tick · 20 Hz snapshot                       │
                               └─────────────────────────────────────────────────────┘
```

## Document index for this folder

| # | File | Topic |
|---|------|-------|
| 00 | [`00_OVERVIEW.md`](00_OVERVIEW.md) | This file. |
| 01 | [`01_PROTOCOL.md`](01_PROTOCOL.md) | Wire protocol: every event name, payload, direction, frequency. |
| 02 | [`02_CLOCK_SYNC.md`](02_CLOCK_SYNC.md) | NTP-style ping/pong, EMA, drift detection. |
| 03 | [`03_SERVER_SIM.md`](03_SERVER_SIM.md) | Server tick loop, input application, physics, hit detection. |
| 04 | [`04_CLIENT_PREDICTION.md`](04_CLIENT_PREDICTION.md) | Local-player prediction + reconciliation on snapshot. |
| 05 | [`05_INTERPOLATION.md`](05_INTERPOLATION.md) | Remote-player buffered interpolation with quaternion slerp. |
| 06 | [`06_HIT_REGISTRATION.md`](06_HIT_REGISTRATION.md) | v1 naïve sphere-vs-sphere; lag comp roadmap. |
| 07 | [`07_ROOMS_AND_LIFECYCLE.md`](07_ROOMS_AND_LIFECYCLE.md) | Single global room, join/leave, max players, heartbeats. |
| 08 | [`08_FRONTEND_INTEGRATION.md`](08_FRONTEND_INTEGRATION.md) | Concrete plan for the new `frontend/src/net/` folder + `gameLoop.ts` rewire. |
| 09 | [`09_BACKEND_STRUCTURE.md`](09_BACKEND_STRUCTURE.md) | Concrete file layout for `backend/src/` (sim/, net/, utils/). |

## Numerical parameters at a glance

```ts
// Add to packages/shared/src/config.ts in a new NET block
export const NET = {
  SERVER_TICK_HZ:        30,
  SERVER_TICK_MS:        1000 / 30,        // 33.33
  SNAPSHOT_HZ:           20,
  SNAPSHOT_MS:           1000 / 20,        // 50
  CLIENT_INPUT_SEND_HZ:  30,               // throttle: send every 2nd 60Hz tick
  INTERP_DELAY_MS:       100,
  EXTRAPOLATION_CAP_MS:  150,
  CLOCK_SYNC_INITIAL_SAMPLES:   5,
  CLOCK_SYNC_PAUSE_MS:          200,
  CLOCK_SYNC_MAINTENANCE_MS:    1000,
  CLOCK_SYNC_EMA_ALPHA:         0.12,
  CLOCK_SYNC_DRIFT_RESYNC_MS:   80,
  CLOCK_SYNC_RTT_SPIKE_MS:      180,
  MAX_PLAYERS_PER_ROOM:         16,
  HEARTBEAT_TIMEOUT_MS:         15000,     // Socket.IO default-ish
  INPUT_BUFFER_RING_SIZE:       128,       // ~2.1 s at 60 Hz
  REMOTE_SNAPSHOT_BUFFER_MAX:   60,        // 3 s at 20 Hz
  HIT_RADIUS_PLAYER:            2.5,       // > PLANE.COLLIDER_RADIUS for forgiveness
  HIT_RADIUS_PROJECTILE:        0.7,       // matches PROJECTILE.RADIUS
  PROJECTILE_DAMAGE:            1,         // 1 hit = 1 life off PLAYER.MAX_LIVES (=5)
} as const;
```
