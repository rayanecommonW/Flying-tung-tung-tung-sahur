# Networking — 09 — Backend Structure

The current [`backend/src/`](../../backend/src/) is two files (~50 lines): `index.ts` boots `Bun.serve`, `server.ts` exports `createServer()` returning a Hono `fetch` and a Socket.IO `Server`. There are no event handlers, no game state, nothing else. This document specifies the folder + files we add to turn that stub into the v1 server.

## Target tree

```
backend/src/
├── index.ts                    // entry — http+socket.io setup, top-level lifecycle
├── server.ts                   // existing Hono /health server (unchanged)
├── net/
│   └── socketHandlers.ts       // wires socket events to the room
├── sim/
│   ├── room.ts                 // Room class (players, projectiles, tick loop, snapshots)
│   ├── player.ts               // ServerPlayer factory + helpers
│   ├── projectile.ts           // ServerProjectile factory + helpers
│   ├── physics.ts              // re-exports from packages/shared/src/sim/* + nose-offset constant
│   └── hitDetection.ts         // detectProjectileVsPlayerHits()
└── utils/
    ├── clock.ts                // monotonic getServerTimeMs()
    └── ids.ts                  // monotonic projectile id generator
```

Each file's responsibilities below.

## `backend/src/index.ts`

Boots the HTTP server *and* attaches Socket.IO to it via `@socket.io/bun-engine`, then constructs the `Room`, registers handlers, and starts the tick loop.

```ts
// sketch
import { createServer } from './server';
import { Room } from './sim/room';
import { registerSocketHandlers } from './net/socketHandlers';
import { CITY } from '@flying-tung-tung/shared';

const port = Number(process.env.PORT ?? 3001);
const { fetch, io } = createServer();          // existing factory; still returns Hono fetch + Socket.IO Server

// Single global room — see plans/networking/07_ROOMS_AND_LIFECYCLE.md
const room = new Room(io, /* citySeed */ CITY.SEED);
registerSocketHandlers(io, room);
room.start();                                  // begins the 30 Hz tick loop

Bun.serve({ port, fetch });

console.info(`[backend] listening on :${port} — single room ready`);
console.info(`[backend] tick=${1000/room.tickMs}Hz snapshot=${1000/room.snapshotMs}Hz seed=${room.seed}`);
```

`createServer()` in [`backend/src/server.ts`](../../backend/src/server.ts) needs **no behavioural change** for v1 — Socket.IO attaches via `@socket.io/bun-engine` already declared in [`backend/package.json`](../../backend/package.json:20). The only update is making sure the `io` returned actually shares the Bun HTTP engine instead of opening its own listener (Garama bypasses this by giving Socket.IO its own port at line 18 of [`Garama/backend/src/server.ts`](../../../Garama/backend/src/server.ts:18) — we'll do the cleaner approach of one port).

## `backend/src/net/socketHandlers.ts`

The single function `registerSocketHandlers(io, room)` registers every server-side handler from [`01_PROTOCOL.md`](01_PROTOCOL.md):

```ts
export function registerSocketHandlers(io: Server, room: Room): void {
  io.on('connection', (socket) => {
    // 5 s "must hello" deadline
    const helloDeadline = setTimeout(() => {
      socket.emit('kicked', { reason: 'banned', message: 'No hello in time' });
      socket.disconnect(true);
    }, 5000);

    socket.on('hello',     (m: HelloPayload) => { clearTimeout(helloDeadline); handleHello(socket, m, room); });
    socket.on('ping',      (m: PingPayload)  => handlePing(socket, m));
    socket.on('input',     (m: InputPayload) => handleInput(socket, m, room));
    socket.on('disconnect', (reason)         => { clearTimeout(helloDeadline); handleDisconnect(socket, reason, room); });
  });
}
```

Per-handler responsibilities:

- **`handleHello`** — version + capacity check (kick on fail), build `ServerPlayer`, push into `room.players`, `socket.join(Room.ID)`, emit `welcome` to the socket, broadcast `playerJoined` to others. Spawn pose comes from `room.spawnPicker.choose(...)`.
- **`handlePing`** — `socket.emit('pong', { clientSendTimeMs, serverTimeMs: getServerTimeMs(), serverTick: room.tick })`. Pong is **socket-targeted**, never broadcast.
- **`handleInput`** — basic shape validation, append to `player.inputQueue`, update `player.lastHeardAt`. Drop if `player.alive === false`. Drop if queue would exceed a sanity ceiling (e.g. 64 inputs — that's >2 s of buffered backlog and means the tick loop is failing).
- **`handleDisconnect`** — see [`07_ROOMS_AND_LIFECYCLE.md`](07_ROOMS_AND_LIFECYCLE.md). Remove from `room.players`, broadcast `playerLeft`. Do **not** despawn the player's projectiles.

## `backend/src/sim/room.ts`

The biggest file. Owns the world, the tick loop, the snapshot accumulator, the events buffer, and the spawn picker.

```ts
export class Room {
  static readonly ID = 'global';
  static readonly MAX_PLAYERS = NET.MAX_PLAYERS_PER_ROOM;

  readonly tickMs     = NET.SERVER_TICK_MS;
  readonly snapshotMs = NET.SNAPSHOT_MS;

  readonly players     = new Map<string, ServerPlayer>();
  readonly projectiles = new Map<number, ServerProjectile>();
  tick = 0;
  private snapshotAcc = 0;
  private nextTickAt  = 0;
  private running = false;

  readonly eventsBuffer: EventsBuffer = freshEventsBuffer();

  constructor(public readonly io: Server, public readonly seed: number) {}

  start(): void {
    this.nextTickAt = performance.now();
    this.running = true;
    this.scheduleNextTick();
  }
  stop(): void { this.running = false; }

  private scheduleNextTick(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    setTimeout(() => this.tickOnce(), delay);
  }

  private tickOnce(): void {
    if (!this.running) return;
    const now = getServerTimeMs();

    // 1+2 inputs + physics
    for (const player of this.players.values()) {
      const inputs = player.inputQueue.splice(0)
                       .filter(i => i.seq > player.lastAppliedSeq);
      if (inputs.length === 0 && player.alive) {
        applyPlaneInput(player, IDLE_INPUT(player), this.tickMs / 1000);
      } else {
        for (const i of inputs) {
          applyPlaneInput(player, i, i.dt);
          player.lastAppliedSeq = i.seq;
          if (i.fire) tryFire(this, player, now);
        }
      }
    }

    // 4 projectiles
    for (const p of this.projectiles.values()) integrateAndDespawn(p, this, this.tickMs / 1000);

    // 5 hits
    detectProjectileVsPlayerHits(this.projectiles, this.players, now, this.eventsBuffer, this.tick);

    // 6+7 deaths/respawns
    resolveDeathsAndRespawns(this.players, now, this.spawnPicker, this.eventsBuffer, this.tick);

    // 8 bounds
    for (const player of this.players.values()) clampToWorld(player);

    // Heartbeat timeout
    for (const player of this.players.values()) {
      if (now - player.lastHeardAt > NET.HEARTBEAT_TIMEOUT_MS) {
        player.socket.disconnect(true);    // triggers handleDisconnect cleanup
      }
    }

    // 9 snapshot accumulator
    this.snapshotAcc += this.tickMs;
    if (this.snapshotAcc >= this.snapshotMs) {
      this.emitSnapshot();
      this.snapshotAcc -= this.snapshotMs;
    }

    this.tick++;
    this.nextTickAt += this.tickMs;
    // Drift drop: if we're more than one tick behind, skip ahead to "now".
    if (performance.now() - this.nextTickAt > this.tickMs) {
      this.nextTickAt = performance.now() + this.tickMs;
      console.warn('[room] tick fell behind; resyncing nextTickAt');
    }
    this.scheduleNextTick();
  }

  private emitSnapshot(): void {
    const payload: SnapshotPayload = {
      tick: this.tick,
      serverTimeMs: getServerTimeMs(),
      players: [...this.players.values()].map(toSnapshotPlayer),
      projectiles: [...this.projectiles.values()]
                     .filter(p => p.alive)
                     .map(toSnapshotProjectile),
      acks: [...this.players.values()].map(p => ({ id: p.id, seq: p.lastAppliedSeq })),
      events: drainEventsBuffer(this.eventsBuffer),
    };
    this.io.to(Room.ID).emit('snapshot', payload);
  }

  // === Spawn picker (see 07_ROOMS_AND_LIFECYCLE.md) ===
  readonly spawnPicker = new SpawnPicker();
}
```

The methods are split so `room.ts` is mostly orchestration; the heavy math lives in `sim/physics.ts` and `sim/hitDetection.ts`.

## `backend/src/sim/player.ts`

```ts
export interface ServerPlayer {
  id: string;
  socket: Socket;
  name: string;
  position: Vec3;
  velocity: Vec3;
  orientation: Vec4;
  hp: number;
  lives: number;
  alive: boolean;
  turbo: boolean;

  inputQueue: InputPayload[];
  lastAppliedSeq: number;
  lastShotAt: number;
  immunityUntil: number;

  joinedAt: number;
  lastHeardAt: number;
  pendingRespawnAt: number | null;
}

export function createServerPlayer(
  socket: Socket, name: string,
  spawn: { position: Vec3; orientation: Vec4 },
  now: number
): ServerPlayer { /* ... */ }

export function toSnapshotPlayer(p: ServerPlayer): SnapshotPlayer { /* ... */ }
```

## `backend/src/sim/projectile.ts`

```ts
export interface ServerProjectile {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  spawnTick: number;
  ttl: number;
  alive: boolean;
}

export function createServerProjectile(
  ownerId: string, origin: Vec3, forward: Vec3, spawnTick: number
): ServerProjectile { /* ... */ }

export function toSnapshotProjectile(p: ServerProjectile): SnapshotProjectile { /* ... */ }

// Tries to fire from this player; respects cooldown. Pushes spawn event into buffer.
export function tryFire(room: Room, player: ServerPlayer, now: number): void { /* ... */ }
```

## `backend/src/sim/physics.ts`

A thin re-export wrapper over the *to-be-created* shared sim module. The intent is that **the same TypeScript files in `packages/shared/src/sim/`** are imported by both [`frontend/src/game/systems/planeController.ts`](../../frontend/src/game/systems/planeController.ts) and the server's `room.ts`:

```ts
// packages/shared/src/sim/applyPlaneInput.ts (NEW)
export function applyPlaneInput(player: PlayerState, input: InputPayload, dt: number): void { /* shared math */ }

// packages/shared/src/sim/integrateProjectile.ts (NEW)
export function integrateProjectile(p: ProjectileState, dt: number): void { /* shared math */ }

// packages/shared/src/sim/clampToWorld.ts (NEW)
export function clampToWorld(p: PlayerState): void { /* shared math */ }
```

Then:

```ts
// backend/src/sim/physics.ts
export { applyPlaneInput, integrateProjectile, clampToWorld } from '@flying-tung-tung/shared';

// Plus backend-only helpers:
export const PLAYER_NOSE_OFFSET = 3.5;   // see 03_SERVER_SIM.md "Open question"

export function forwardFromQuat(q: Vec4, out?: Vec3): Vec3 { /* in-line math */ }

export const IDLE_INPUT = (player: ServerPlayer): InputPayload => ({
  seq: player.lastAppliedSeq,             // not advanced
  dt: NET.SERVER_TICK_MS / 1000,
  clientTimeMs: 0,
  axes: { pitch: 0, yaw: 0, roll: 0, throttle: 1 },
  turbo: player.turbo,
  fire: false, dodge: false,
});
```

## `backend/src/sim/hitDetection.ts`

Self-contained — see [`06_HIT_REGISTRATION.md`](06_HIT_REGISTRATION.md). Exports:

```ts
export function detectProjectileVsPlayerHits(
  projectiles: Map<number, ServerProjectile>,
  players:     Map<string, ServerPlayer>,
  now:         number,
  events:      EventsBuffer,
  tick:        number
): void;

export function resolveDeathsAndRespawns(
  players:     Map<string, ServerPlayer>,
  now:         number,
  spawnPicker: SpawnPicker,
  events:      EventsBuffer,
  tick:        number
): void;
```

## `backend/src/utils/clock.ts`

```ts
const startNs = process.hrtime.bigint();   // monotonic, immune to wall-clock changes

export function getServerTimeMs(): number {
  // Bun supports performance.now() as well; either works since we just need monotonic.
  return Number((process.hrtime.bigint() - startNs) / 1_000_000n);
}
```

(Equivalent to Garama's `process.uptime() * 1000` but slightly more precise.)

## `backend/src/utils/ids.ts`

```ts
let _nextProj = 1;
export function nextProjectileId(): number { return _nextProj++; }
```

Monotonic forever within a process. We don't reuse ids — even if the projectile died 10 minutes ago, its id never comes back. This means clients can keep "this id was a hit" cached without worrying about collisions. At 30 Hz cooldown × 16 players × 12-hour uptime that's ~2.1 M ids — well under 32-bit range. We don't need wraparound.

## What changes in the existing two files

### [`backend/src/server.ts`](../../backend/src/server.ts)

**Mostly unchanged.** Today it constructs `new Server({ cors: { origin: '*' } })` and returns it for the caller to attach event handlers. We keep that. The CORS config might need to be `origin: ['http://localhost:5173']` in dev (Vite's port) but `'*'` is fine for v1.

The one change is documenting that `createServer` is now expected to be wired with handlers + a tick loop by `index.ts`:

```ts
/**
 * Backend factory. Returns a Hono fetch + a (so far un-handlered) Socket.IO
 * Server. Handlers are wired by registerSocketHandlers in net/socketHandlers.ts;
 * the tick loop is started by Room#start() in sim/room.ts. See plans/networking/.
 */
export function createServer(): { fetch: ...; io: Server } { /* current impl + Socket.IO ↔ Bun.serve binding */ }
```

### [`backend/src/index.ts`](../../backend/src/index.ts)

Replaced as shown at the top of this doc.

## Dependency check vs `backend/package.json`

What we need:
- ✅ `socket.io` (4.8.1) — already declared
- ✅ `@socket.io/bun-engine` (0.0.3) — already declared
- ✅ `@flying-tung-tung/shared` (workspace) — already declared
- ✅ `hono` (4.10.1) — already declared
- ❌ Nothing new needed for v1.

Future deps we won't pull in v1:
- `bullmq` / `redis` for cross-process state (multi-room scaling).
- `zod` for runtime payload validation. *Worth considering even for v1* — Garama doesn't use it and we can match. Keep type-validate-on-read implicit; if we hit a malformed-payload bug, add `zod` then.

## Process-management & dev experience

[`backend/package.json`](../../backend/package.json:8) already has `"dev": "bun run --watch ./src/index.ts"`. Keep that. The watcher will restart on any change in `backend/src/`, dropping all sockets — which is fine in v1, players will see "Server lost — refresh".

[`turbo.json`](../../turbo.json) already pipelines `dev` across workspaces, so root-level `bun run dev` starts both frontend and backend with one command. No changes there.

## Logging

For v1 we use `console.info` / `console.warn` only. Useful one-liners:

- On start: `[room] tick=30Hz snapshot=20Hz seed=1337`
- On hello: `[room] +join id=Abc123 name="Tung42" players=2/16`
- On disconnect: `[room] -left id=Abc123 reason=transport_close players=1/16`
- On kick: `[room] kicked id=Xyz999 reason=room-full`
- On tick drift: `[room] tick fell behind; resyncing nextTickAt`

Anything more elaborate (structured logs, metrics) is post-v1.
