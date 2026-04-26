# Networking — 07 — Rooms & Lifecycle

## v1: a single global room

There is **one** room per server process, hardcoded `ROOM_ID = 'global'`. Every connected socket goes into it. No matchmaking, no instances, no game modes, no map selection. This matches Garama's [`'match'` constant](../../../Garama/backend/src/server.ts:8) and is the correct simplification for v1: getting two browsers to shoot each other is the goal — anything that can be cut to reduce time-to-fun should be cut.

The `Room` class exists in [`backend/src/sim/room.ts`](../../backend/src/sim/room.ts) and owns:

- `players: Map<string, ServerPlayer>` keyed by socket id.
- `projectiles: Map<number, ServerProjectile>` keyed by projectile id.
- The 30 Hz tick loop ([`03_SERVER_SIM.md`](03_SERVER_SIM.md)).
- The 20 Hz snapshot accumulator.
- `tick: number` — monotonic since process start.
- `eventsBuffer: { spawns, despawns, hits, deaths, respawns }` — drained on snapshot.
- `spawnPicker` — see below.

```ts
// backend/src/sim/room.ts
export class Room {
  static readonly ID = 'global';
  static readonly MAX_PLAYERS = NET.MAX_PLAYERS_PER_ROOM;        // 16

  readonly players     = new Map<string, ServerPlayer>();
  readonly projectiles = new Map<number, ServerProjectile>();
  tick = 0;
  // ... etc.

  constructor(public readonly io: Server, public readonly seed: number) {}

  isFull(): boolean { return this.players.size >= Room.MAX_PLAYERS; }
}
```

The single `Room` instance is created in [`backend/src/index.ts`](../../backend/src/index.ts) and passed into [`backend/src/net/socketHandlers.ts`](../../backend/src/net/socketHandlers.ts).

## Connection lifecycle (per socket)

```
1. socket.io 'connect'
     ─► handler attaches event listeners. No player added yet.
     ─► handler starts a 5 s "must hello" timer.

2. client emits 'hello' with name + protocolVersion + clientTimeMs
     ─► server validates:
        - protocolVersion matches PROTOCOL_VERSION → otherwise emit 'kicked' {reason:'version-mismatch'} and disconnect(true)
        - room.isFull() → otherwise emit 'kicked' {reason:'room-full'} and disconnect(true)
     ─► server cancels the "must hello" timer.
     ─► server creates ServerPlayer:
        - id = socket.id
        - name = sanitize(msg.name)         // trim, length-cap 24, strip control chars
        - position/orientation from spawnPicker
        - lives = PLAYER.MAX_LIVES, alive = true, hp = MAX_LIVES
        - immunityUntil = now + PLAYER.IMMUNITY_SEC * 1000
        - lastAppliedSeq = 0
        - inputQueue = []
        - joinedAt = now, lastHeardAt = now
     ─► server adds to room.players
     ─► server: socket.join(Room.ID)
     ─► server emits 'welcome' to socket only
        (player count, world seed, spawn pose, others[])
     ─► server emits 'playerJoined' to room except sender

3. client emits 'ping' / server replies 'pong' (5×, 200ms)
     ─► clock-sync handshake completes (see 02_CLOCK_SYNC.md)

4. client starts emitting 'input' (30Hz)
     ─► server appends to player.inputQueue, updates lastHeardAt
     ─► next tick consumes the queue

5. while connected:
     ─► snapshots flow at 20 Hz to all sockets in room
     ─► additional 'ping' at 1 Hz from client; server pongs
     ─► server checks lastHeardAt vs now per tick; if > HEARTBEAT_TIMEOUT_MS → kick

6. socket.io 'disconnect' (any reason)
     ─► server removes from room.players
     ─► server broadcasts 'playerLeft' {id, reason}
     ─► server does NOT despawn that player's in-flight projectiles —
        they continue until lifetime/hit, attributed to a now-absent ownerId
     ─► server cleans the socket-level listeners (Socket.IO does this automatically)
```

### "Must hello" timer

A connected socket that never sends `hello` within 5 s gets force-disconnected. This prevents zombie connections from holding a slot. Socket.IO's own ping/pong heartbeat handles dead TCP, but a slow/malicious client could connect and never speak — the timer covers that.

```ts
// backend/src/net/socketHandlers.ts (excerpt)
io.on('connection', (socket) => {
  const helloDeadline = setTimeout(() => {
    socket.emit('kicked', { reason: 'banned', message: 'No hello in time' } satisfies KickedPayload);
    socket.disconnect(true);
  }, 5000);

  socket.on('hello', (msg: HelloPayload) => {
    clearTimeout(helloDeadline);
    handleHello(socket, msg, room);
  });
  // ...
});
```

## Spawn point selection

The spawn picker lives in [`backend/src/sim/room.ts`](../../backend/src/sim/room.ts) (`spawnPicker.choose(players)`) and runs whenever:

- A new player joins (called from the `hello` handler).
- A dead player's `pendingRespawnAt` lapses (see [`03_SERVER_SIM.md`](03_SERVER_SIM.md) §7).

### Algorithm

The current single-player spawn is `(0, 80, 0)` ([`gameState.ts`](../../frontend/src/game/gameState.ts:53)) inside the `SPAWN_SAFE_RADIUS_CELLS = 4` plaza forced empty by [`CITY`](../../packages/shared/src/config.ts:118). For multiplayer we need at least N≥2 spawn points so two new players don't collide.

```ts
// 8 spawn points around the safe plaza, at altitude 80, all heading "outward"
const SPAWN_POINTS = [
  // {position, orientation} pairs, generated once at room init
  // pos = (cos(θ_i)·R, 80, sin(θ_i)·R) with R = 60 (well inside the 4-cell plaza)
  // orientation = quaternion that points the plane along (cos θ_i, 0, sin θ_i)
];   // 8 entries

function choose(players: Map<string, ServerPlayer>): { position: Vec3; orientation: Vec4 } {
  // Pick the spawn point furthest from the nearest live player.
  let best = SPAWN_POINTS[0];
  let bestMinSqDist = -Infinity;
  for (const sp of SPAWN_POINTS) {
    let minSqDist = Infinity;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const dx = p.position.x - sp.position.x;
      const dz = p.position.z - sp.position.z;
      const d2 = dx*dx + dz*dz;
      if (d2 < minSqDist) minSqDist = d2;
    }
    if (minSqDist > bestMinSqDist) {
      bestMinSqDist = minSqDist;
      best = sp;
    }
  }
  return { position: { ...best.position }, orientation: { ...best.orientation } };
}
```

For an empty room (first joiner), `minSqDist = +Infinity` and the first spawn point wins. For a respawn while others are present, we get the spot **maximally far from the nearest opponent** — simple "anti-spawn-camp" logic.

`R = 60` keeps every spawn well inside the spawn-safe plaza guaranteed by [`CITY.SPAWN_SAFE_RADIUS_CELLS`](../../packages/shared/src/config.ts:118), so spawning planes never start inside a building.

## Heartbeat & timeout

The server tracks `player.lastHeardAt = serverTimeMs` whenever:

- An `input` from this player is received.
- A `ping` from this player is received.
- A `chat` (when implemented).

Each tick, the room iterates players and:

```ts
if (now - player.lastHeardAt > NET.HEARTBEAT_TIMEOUT_MS) {       // 15000
  player.socket.disconnect(true);                                // triggers normal disconnect cleanup
}
```

This catches "client suspended its main thread for >15 s" scenarios that Socket.IO's own heartbeat (which uses transport-level pings) might let through. We defer to Socket.IO's heartbeat for true network-dead detection.

### Why 15 000 ms?

- A correctly-functioning client sends `input` at 30 Hz = every 33 ms.
- A laptop that goes to sleep can pause `requestAnimationFrame` for tens of seconds before macOS/Windows TCP-keepalive kills the socket.
- 15 s is long enough that we don't kill players for genuine packet loss, short enough to clean up dead tabs in human time.

## Graceful disconnect

On `socket.on('disconnect')` (reasons: `transport close`, `client namespace disconnect`, `ping timeout`, etc.):

```ts
socket.on('disconnect', (reason) => {
  const player = room.players.get(socket.id);
  if (!player) return;                       // never had a player (no hello, or already cleaned up)

  room.players.delete(socket.id);

  io.to(Room.ID).emit('playerLeft', {
    id: socket.id,
    reason: reason === 'ping timeout' ? 'timeout' : 'disconnect',
  } satisfies PlayerLeftPayload);

  // Projectiles owned by this player keep flying. Their ownerId still matches
  // the (now-removed) player; the next snapshot will list them with that
  // ownerId, but no SnapshotPlayer will exist for it. Clients tolerate this.
});
```

We deliberately do not nuke the player's in-flight projectiles. Their motion is server-deterministic and they'll despawn within `PROJECTILE.LIFETIME_SEC = 2.5 s`. Killing them mid-flight would create a "did the bullet hit?" race condition that's not worth the complexity.

## Reconnect (or rather: re-join)

V1 has **no resumable session.** A page refresh produces a brand-new socket id; the new socket joins as a brand-new player from a fresh spawn. Score, lives, and any in-flight projectiles owned by the old socket are gone (well, projectiles persist as ownerless rounds for ≤2.5 s).

This is good enough because:

- Score is volatile in v1 anyway (no persistence).
- The cost of "lose your session on refresh" is one missed dogfight, not lost progression.
- Re-join semantics interact badly with our `lastAppliedSeq` model — a reconnected client would have to wipe its input ring and start over, which is just "join fresh" with extra complexity.

V2 can add `hello.sessionToken` for short-window resumes if needed.

## Room-full kick

When a player tries to join the 17th slot:

```ts
if (room.isFull()) {
  socket.emit('kicked', {
    reason: 'room-full',
    message: `Room is full (${Room.MAX_PLAYERS}/${Room.MAX_PLAYERS}). Try again in a minute.`,
  } satisfies KickedPayload);
  socket.disconnect(true);
  return;
}
```

The frontend's loading screen reads `KickedPayload.message` and displays it. No retry logic in v1 — user closes tab.

## Failure modes & their behaviours

| Failure | What happens |
|---------|--------------|
| Client never sends `hello` | 5 s timeout → `kicked {reason:'banned', message:'No hello in time'}` → disconnect. |
| Client sends bogus `hello.protocolVersion` | `kicked {reason:'version-mismatch'}` → disconnect. |
| Client connects when room is full | `kicked {reason:'room-full'}` → disconnect. |
| Server process dies | All sockets get `disconnect`; clients freeze the world & display "Server lost". |
| Network blip < `pingTimeout` (Socket.IO default 20 s) | Socket.IO buffers; messages resume. Client may see snapshot gap >100 ms; interpolation extrapolates up to 150 ms then freezes; reconciliation snaps when snapshots resume. |
| Network blip > `pingTimeout` | Socket.IO disconnects; treated as client-side disconnect. |
| Player tab goes to sleep | `lastHeardAt` exceeds `HEARTBEAT_TIMEOUT_MS` → server kicks. Tab wakes, sees `disconnect`. |

## File responsibilities

```
backend/src/sim/room.ts
  - class Room with players, projectiles, tick loop, snapshot accumulator,
    spawnPicker, eventsBuffer

backend/src/net/socketHandlers.ts
  - registerSocketHandlers(io, room) — wires every event listed in 01_PROTOCOL
  - handleHello(socket, msg, room) — admit / kick + spawn + emit welcome + broadcast playerJoined
  - handleDisconnect(socket, reason, room) — cleanup + broadcast playerLeft
```
