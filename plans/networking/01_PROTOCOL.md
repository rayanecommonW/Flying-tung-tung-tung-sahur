# Networking — 01 — Protocol

This document is the **wire-protocol contract** between [`backend/`](../../backend/) and [`frontend/`](../../frontend/). Every event, every payload, every direction. If [`backend/src/`](../../backend/src/) and [`frontend/src/net/`](../../frontend/src/) disagree, this file is the tiebreaker. The TypeScript declarations land in [`packages/shared/src/events.ts`](../../packages/shared/src/events.ts) (which today already has placeholders) so both sides type-check the same shapes.

## Conventions

- **Direction**: `C→S` = client to server, `S→C` = server to client, `S→all` = server broadcasts to every socket in the room.
- **Frequency**: typical message rate. "On event" means it fires only when the named user / state event occurs.
- **Encoding**: JSON via Socket.IO. No binary in v1.
- **Time**: `serverTimeMs` is monotonic milliseconds since server process start (`process.uptime() * 1000`, like Garama). `clientTimeMs` is `performance.now()`. Neither is wall-clock.
- **IDs**: `playerId = socket.id` (Socket.IO assigns a stable random string on connect). `projectileId` is a server-assigned monotonic `number` allocated by [`backend/src/utils/ids.ts`](../../backend/src/utils/ids.ts). The local-only client `id = 'local'` from [`frontend/src/game/gameState.ts`](../../frontend/src/game/gameState.ts:71) is replaced by the real socket id once `welcome` arrives.
- **Quaternions on the wire**: full `{x, y, z, w}` for v1. We do not normalize before sending; the receiver normalizes after `slerp`. A future doc will introduce 3-component compression (sign-of-w + xyz) when bandwidth becomes a concern.

## Event reference table

| Direction | Event | Frequency | Trigger |
|-----------|-------|-----------|---------|
| C→S | `hello` | 1× per connection | First message after `connect` |
| S→C | `welcome` | 1× per connection | Reply to `hello` |
| C→S | `ping` | ~5× burst at join, then 1 Hz | Clock sync — see [`02_CLOCK_SYNC.md`](02_CLOCK_SYNC.md) |
| S→C | `pong` | 1× per `ping` | Reply only to the requesting socket |
| C→S | `input` | 30 Hz | Every other 60 Hz client tick |
| S→all | `snapshot` | 20 Hz | Server snapshot accumulator |
| S→all | `playerJoined` | on event | New player accepted into room |
| S→all | `playerLeft` | on event | Disconnect or kick |
| S→C | `kicked` | on event | Server-initiated disconnect (room full, version mismatch) |
| C→S | `chat` *(reserved, deferred)* | low | Future text chat |
| S→all | `chat` *(reserved, deferred)* | low | Future text chat |

The "recent events" inside a `snapshot` payload (hits, deaths, spawns, despawns) replace the per-event broadcasts that Garama uses (`damage`, `death`, `attack_vfx`). One snapshot envelope keeps state and effects consistent at the same `serverTick`, so a late or dropped per-event message can never desync the visuals.

## TypeScript event names

Replace the placeholder `EVENTS` constant in [`packages/shared/src/events.ts`](../../packages/shared/src/events.ts:11) with:

```ts
export const EVENTS = {
  HELLO:          'hello',
  WELCOME:        'welcome',
  PING:           'ping',
  PONG:           'pong',
  INPUT:          'input',
  SNAPSHOT:       'snapshot',
  PLAYER_JOINED:  'playerJoined',
  PLAYER_LEFT:    'playerLeft',
  KICKED:         'kicked',
  // Reserved for v2:
  CHAT:           'chat',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
```

The legacy `JOIN`, `INPUT`, `SHOOT`, `WELCOME`, `STATE`, `PLAYER_HIT`, `PLAYER_LEFT` placeholders in the existing file get deleted as part of this work.

## Payload shapes

All payloads are `interface`s exported from [`packages/shared/src/events.ts`](../../packages/shared/src/events.ts). Keep them flat (no `Map`, no `Set`) so JSON.stringify works directly.

### `hello` (C→S)

Sent immediately after `socket.on('connect')` resolves on the client. **Joining is implicit** — there is no separate `join` event; `hello` *is* the join.

```ts
export interface HelloPayload {
  /** Display name. Server sanitizes (trim, length-cap 24, strip control chars). */
  name: string;
  /**
   * Protocol version baked into the shared package. Bumped whenever a
   * breaking event-shape change ships. Server kicks on mismatch.
   */
  protocolVersion: number;
  /** Client wall time of send (`performance.now()`); echoed in welcome for the first RTT estimate. */
  clientTimeMs: number;
}
```

### `welcome` (S→C)

The single envelope that bootstraps everything the client needs to start interpolating + predicting.

```ts
export interface WelcomePayload {
  /** The player's id == socket.id. The client copies this into `state.player.id` and the local-id tag on every projectile spawned from prediction. */
  playerId: string;
  /** Server tick number at the moment of welcome. Used as the prediction baseline. */
  serverTick: number;
  /** Server time at the moment of welcome (echoed in PongPayload too). */
  serverTimeMs: number;
  /** Server tick rate so the client knows how to scale dt-converted values. */
  serverTickHz: number;     // 30
  /** Snapshot rate so the client can size its interpolation buffer. */
  snapshotHz: number;       // 20
  /** Authoritative city seed so every client renders the same procedural map. */
  citySeed: number;
  /** Initial pose chosen by the spawn picker. The client snaps the local plane to this. */
  spawn: {
    position: Vec3;
    orientation: Vec4;
  };
  /** Current roster excluding self. The client creates remote-plane shells for each before the first snapshot lands. */
  others: Array<{
    id: string;
    name: string;
    position: Vec3;
    orientation: Vec4;
    hp: number;
    lives: number;
    alive: boolean;
  }>;
}
```

### `ping` / `pong` (C↔S)

Pure clock-sync. The server does **not** broadcast pongs — only the requesting socket gets a reply. Algorithm specified in [`02_CLOCK_SYNC.md`](02_CLOCK_SYNC.md).

```ts
export interface PingPayload {
  clientSendTimeMs: number;   // performance.now() at send time
}

export interface PongPayload {
  clientSendTimeMs: number;   // echoed verbatim
  serverTimeMs: number;       // process-uptime ms at the moment the server saw the ping
  serverTick: number;         // for free; sometimes useful for first-time interp alignment
}
```

### `input` (C→S, 30 Hz)

The client sends one `InputPayload` every other 60 Hz tick (= 30 Hz). Inputs are **incremental** in spirit — `dt` describes how long this input was active — but always carry full state (turbo, fire, axes) so the server doesn't need a second "release" event when a button comes up.

```ts
export interface InputPayload {
  /**
   * Monotonic per-client input number, starting at 1 on connect.
   * Used for reconciliation: the server echoes the highest seq it has
   * applied in every snapshot, and the client replays unacked inputs
   * past that seq. See plans/networking/04_CLIENT_PREDICTION.md.
   */
  seq: number;
  /** Sim-seconds this input represents (sum of the local sub-ticks it batches). */
  dt: number;
  /** Client time at send for one-way latency telemetry; not used for sim. */
  clientTimeMs: number;
  /**
   * Control axes. Mouse-pixel deltas are converted to axes on the client
   * (already done by planeController.ts via PLANE.YAW_SENSITIVITY etc.)
   * so the wire shape stays small + bounded.
   *
   * Each axis is in [-1, +1]. Pitch and yaw are pre-saturated through
   * tanh on the client (matches softLimit() in planeController.ts:27).
   */
  axes: {
    pitch:    number;     // signed, after tanh saturation
    yaw:      number;     // signed, after tanh saturation
    roll:     number;     // 0 in v1 — reserved for explicit roll keybinds
    throttle: number;     // 0..1; 1 == cruise, server multiplies by TURBO_MULT if turbo set
  };
  /** Held this tick: turbo on. */
  turbo: boolean;
  /** Edge-triggered: client wants to fire a projectile. Server gates by cooldown. */
  fire: boolean;
  /** Edge-triggered: dodge requested. Server gates by cooldown + alive. */
  dodge: boolean;
}
```

Notes:

- **Why pre-saturated axes, not raw mouse deltas?** Mouse deltas are device + DPI dependent and would force the server to know the client's pointer-lock semantics. Sensitivity already lives in [`packages/shared/src/config.ts`](../../packages/shared/src/config.ts:13) via `PLANE.YAW_SENSITIVITY`/`PLANE.PITCH_SENSITIVITY`; the client computes the saturated axis once, the server consumes it directly.
- **Why an inputs-include-dt model rather than fixed-tick inputs?** The client runs at 60 Hz but sends at 30 Hz. Each network input therefore covers two local sub-ticks. The server needs to integrate physics for that exact `dt` to stay frame-perfect with the client's prediction.

### `snapshot` (S→all, 20 Hz)

The biggest message. Sent on the server's snapshot accumulator (every 50 ms ≈ every 2nd tick at 30 Hz, but driven by wall time, not tick number). Broadcast to every socket in the room.

```ts
export interface SnapshotPayload {
  /** Server tick at the moment this snapshot was generated. */
  tick: number;
  /** Server time at the moment this snapshot was generated. */
  serverTimeMs: number;

  /**
   * For each connected player, what the server thinks of them right now.
   * Includes self — the local client uses its own entry to reconcile.
   */
  players: SnapshotPlayer[];

  /**
   * Live projectiles. Server pool-allocates ids, never reuses while alive.
   * Despawned projectiles are surfaced via `events.despawns` below for one
   * snapshot, then dropped from this array.
   */
  projectiles: SnapshotProjectile[];

  /**
   * The highest input.seq the server has consumed from THIS recipient.
   * Recipients filter by socket id at deliver time — Socket.IO does not
   * support per-recipient payloads cheaply, so we attach an array.
   *
   * Implementation: `Array<{ id: string; seq: number }>`. Each client looks
   * up its own entry. Tiny payload (≤16 entries × ~50 bytes).
   */
  acks: Array<{ id: string; seq: number }>;

  /**
   * Discrete events that happened between the previous snapshot and this
   * one. Each event carries enough info that the client can drive a
   * one-shot effect (sound, particle burst, HUD flash) without consulting
   * its own state. `tick` is when it happened on the server.
   */
  events: {
    spawns: Array<{ tick: number; projectileId: number; ownerId: string; position: Vec3; velocity: Vec3 }>;
    despawns: Array<{ tick: number; projectileId: number; reason: 'expired' | 'hit-player' | 'hit-building' | 'hit-ground' | 'out-of-bounds'; position: Vec3 }>;
    hits: Array<{ tick: number; victimId: string; attackerId: string; projectileId: number; position: Vec3; livesLeft: number }>;
    deaths: Array<{ tick: number; victimId: string; attackerId: string | null; position: Vec3 }>;
    respawns: Array<{ tick: number; playerId: string; position: Vec3; orientation: Vec4 }>;
  };
}

export interface SnapshotPlayer {
  id: string;
  position: Vec3;
  velocity: Vec3;     // included so extrapolation can do v·dt past last snapshot
  orientation: Vec4;
  hp: number;
  lives: number;
  alive: boolean;
  turbo: boolean;
}

export interface SnapshotProjectile {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  /** Sim-seconds remaining before lifetime expiry. Lets the client estimate fade. */
  ttl: number;
}
```

Sizing sanity check (16 players, ~30 projectiles in flight, no events):

```
players[16]      ≈ 16 × ~140 B  = 2240 B
projectiles[30]  ≈ 30 × ~90 B   = 2700 B
acks[16]         ≈ 16 × ~50 B   = 800 B
envelope         ≈ 200 B
                              ≈ 5.9 kB / snapshot
× 20 Hz                       ≈ 118 kB/s downstream per client
```

Acceptable for v1 over LAN. Compression to 3-component quats + delta-encoded positions will bring this down ~3× when needed.

### `playerJoined` (S→all)

Fired exactly once per new connection, *after* the server has admitted the player and before its first input is processed. Recipients spin up a remote-plane entity with the given pose.

```ts
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
```

### `playerLeft` (S→all)

Fired on disconnect (graceful or heartbeat-timed-out). Recipients destroy the remote-plane entity.

```ts
export interface PlayerLeftPayload {
  id: string;
  reason: 'disconnect' | 'timeout' | 'kicked';
}
```

### `kicked` (S→C)

Sent only to the affected socket immediately before `socket.disconnect(true)`. Used for room-full rejection and protocol-version mismatch. The client surfaces the reason on the loading screen.

```ts
export interface KickedPayload {
  reason: 'room-full' | 'version-mismatch' | 'banned';
  message: string;     // human-readable
  serverProtocolVersion?: number;   // present iff reason === 'version-mismatch'
}
```

### `chat` (reserved, deferred)

Same shape as Garama for forward compatibility:

```ts
export interface ChatPayloadC2S { message: string; }
export interface ChatPayloadS2A { from: string; message: string; }
```

Not implemented in v1. The event names are reserved so we can layer it on without bumping `protocolVersion`.

## Connection lifecycle (sequence diagram)

```
client                              server
  |  ── socket.io connect ─────────►  |
  |                                   |
  |  ── HELLO {name, ver, t0} ──────► |  validate version, room not full,
  |                                   |  allocate spawn, add to room
  |  ◄─ WELCOME {selfId, tick, t,    │
  |             tickHz, snapHz,       |
  |             citySeed, spawn,      |
  |             others[]}            ─|
  |                                   |
  |  ── PING × 5 (200 ms apart) ────► |  (replies pong each)
  |  ◄─ PONG × 5 ────────────────────|
  |                                   |
  |   (and to other clients:)         |
  |                          PLAYER_JOINED ──► all-other-clients
  |                                   |
  |  ── INPUT (seq=1) ──────────────► |
  |  ── INPUT (seq=2) ──────────────► |
  |     (30 Hz forever)               |
  |                                   |  every 50 ms:
  |  ◄─ SNAPSHOT {tick, players,     |     emit('snapshot', ...) to room
  |              projectiles, acks,  ─|
  |              events}              |
  |                                   |
  |  ── PING (1 Hz maintenance) ────► |
  |  ◄─ PONG ────────────────────────|
  |                                   |
  |  ── socket.io disconnect ───────► |  cleanup, broadcast PLAYER_LEFT
  |                                   |
  |                          PLAYER_LEFT ──► all-other-clients
```

## Disconnect + reconnect semantics for v1

- **Disconnect on the client side** (close tab, navigate away, kill browser): Socket.IO fires `disconnect` on the server. Server removes the player, broadcasts `PLAYER_LEFT { id, reason: 'disconnect' }`. Other clients destroy the remote-plane entity immediately (no fade). Stale projectiles owned by the disconnected player **continue flying** until lifetime/hit — they were already in the world.
- **Heartbeat timeout** (laptop sleeps): Socket.IO's built-in heartbeat (~`pingInterval=25 s`, `pingTimeout=20 s`) detects the dead socket; same path as above with `reason: 'timeout'`.
- **Server crash**: client gets `disconnect`. The frontend net layer freezes the world (no further input sends, no further snapshot processing) and surfaces a "Server lost — refresh to reconnect" overlay. **Reconnection is manual / page-refresh-only in v1.** Auto-reconnect with state recovery (resending `hello` + `welcome` against the same socket id) is future work.
- **Reconnect**: a refreshed client gets a *new* socket id. The server treats it as a brand-new player; spawn picker chooses a fresh point. There is no "rejoin as same player".

## Protocol versioning

Add `PROTOCOL_VERSION = 1` to [`packages/shared/src/events.ts`](../../packages/shared/src/events.ts). Bump on any breaking change (event name, payload field, semantic). The server kicks mismatched clients with `kicked.reason = 'version-mismatch'` so a stale tab doesn't silently desync from a deployed server.
