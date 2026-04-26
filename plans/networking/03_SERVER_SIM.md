# Networking — 03 — Server Simulation

The server is the single source of truth for the world. It runs the same plane physics the client already runs (today, locally, in [`frontend/src/game/systems/planeController.ts`](../../frontend/src/game/systems/planeController.ts)), but for *every* connected player. The work in this doc is what turns the inert backend stub into a real game server.

## Tick model

```
┌────── Room.tick() — 30 Hz, fixed dt = 33.33 ms ─────────────┐
│                                                             │
│  1. drainInputs()      // pull queued inputs per player     │
│  2. applyInputs(dt)    // step plane physics                │
│  3. spawnProjectiles() // from any 'fire' edges this tick   │
│  4. stepProjectiles(dt)                                     │
│  5. detectHits()       // proj vs plane, plane vs city      │
│  6. resolveDeaths()    // mark dead, schedule respawn       │
│  7. resolveRespawns()  // restore lives, choose spawn point │
│  8. enforceWorldBounds()                                    │
│  9. maybeEmitSnapshot() // accumulator, fires every 50 ms   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The tick loop runs in [`backend/src/sim/room.ts`](../../backend/src/sim/room.ts) on a `setInterval(tick, 1000/30)` (or, more accurately, a `setTimeout` self-rescheduler that compensates for drift — see "Drift compensation" below). All physics math reuses what's already in [`packages/shared/src/config.ts`](../../packages/shared/src/config.ts) and (where relevant) factored-out helpers from the frontend's controller.

## Per-player state on the server

```ts
// backend/src/sim/player.ts
export interface ServerPlayer {
  id: string;             // socket.id
  socket: Socket;         // for direct emits (snapshot acks happen via room broadcast)
  name: string;
  position: Vec3;
  velocity: Vec3;
  orientation: Vec4;
  hp: number;             // 0..PLAYER.MAX_LIVES * something — v1: hp == lives (1 hit = 1 life)
  lives: number;          // PLAYER.MAX_LIVES = 5
  alive: boolean;
  turbo: boolean;

  // Networking book-keeping
  inputQueue: InputPayload[];   // FIFO, drained each tick
  lastAppliedSeq: number;       // highest input.seq the server has consumed
  lastShotAt: number;           // serverTimeMs, for projectile cooldown
  immunityUntil: number;        // serverTimeMs, post-respawn / post-hit grace

  // Lifecycle
  joinedAt: number;             // serverTimeMs
  lastHeardAt: number;          // serverTimeMs of last input
  pendingRespawnAt: number | null;
}
```

## Per-projectile state

```ts
// backend/src/sim/projectile.ts
export interface ServerProjectile {
  id: number;                // monotonic from utils/ids.ts
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  spawnTick: number;
  ttl: number;               // sim-seconds remaining
  alive: boolean;
}
```

The server pool-allocates from a single `Map<number, ServerProjectile>`. Unlike the client's [`InstancedMesh`](../../frontend/src/entities/projectile.ts) pool, the server doesn't care about render slots — ids are pure data and we delete on despawn.

## Drift compensation

`setInterval` in Bun (and Node) is **not** drift-free; under load the loop can lag by tens of ms which would slowly shift `serverTime` away from real elapsed time. The pattern (used in many small game servers) is to self-schedule:

```ts
// backend/src/sim/room.ts
let nextTickAt = performance.now();

function loop() {
  const now = performance.now();
  const drift = now - nextTickAt;
  tick();                                    // does NOT take a wall-clock dt; uses fixed NET.SERVER_TICK_MS
  nextTickAt += NET.SERVER_TICK_MS;
  const delay = Math.max(0, nextTickAt - performance.now());
  setTimeout(loop, delay);
}
loop();
```

If the server falls more than `NET.SERVER_TICK_MS` behind, we **drop ticks** rather than try to catch up — running multiple physics steps inside a single wall-clock interval would burn CPU without giving any client snapshots they could use. We log the drop count for observability.

## 1. `drainInputs(player)`

Each player's `inputQueue` is a FIFO. The room reads inputs in `seq` order and consumes every input whose batched `dt` fits within this tick's budget. In v1 we apply **all** queued inputs each tick — Socket.IO orders messages per socket, so there's no reordering bug. If a client batches many inputs (e.g. tab spike, then catch-up), we apply them all here so the server's plane state resyncs to "what the client believes".

```ts
function drainInputs(player: ServerPlayer): InputPayload[] {
  const out = player.inputQueue;
  player.inputQueue = [];
  // Discard any input.seq <= lastAppliedSeq (rare; defensive against duplicate sends).
  return out.filter((i) => i.seq > player.lastAppliedSeq);
}
```

The ordering invariant is: **server tick `T` consumes all inputs that arrived between tick `T-1` and tick `T`**. The remembered `lastAppliedSeq` is broadcast in `snapshot.acks` so the client can reconcile (see [`04_CLIENT_PREDICTION.md`](04_CLIENT_PREDICTION.md)).

## 2. `applyInputs(player, inputs, dt)`

This is the same logic as [`updatePlaneController`](../../frontend/src/game/systems/planeController.ts:50), running on the server, against `ServerPlayer` instead of `GameState.player`. The cleanest path is to factor the math out of the frontend file into a pure helper in `packages/shared` so both sides call the same code:

```
packages/shared/src/sim/
  applyPlaneInput.ts        // pure: (player, input, dt) → mutates player
  integrateProjectile.ts    // pure: (proj, dt) → mutates proj
  hitDetection.ts           // pure: spheres + AABBs
```

Pseudocode for the server-side step:

```ts
for (const input of drainedInputs) {
  applyPlaneInput(player, input, input.dt);   // shared math
  player.lastAppliedSeq = input.seq;
}
// If no inputs arrived this tick (laggy client), advance with the last-known
// turbo + zero axes so the plane keeps drifting forward instead of freezing.
if (drainedInputs.length === 0) {
  applyPlaneInput(player, IDLE_INPUT, NET.SERVER_TICK_MS / 1000);
}
```

`IDLE_INPUT` = `{ axes: { pitch: 0, yaw: 0, roll: 0, throttle: 1 }, turbo: player.turbo, fire: false, dodge: false, dt: tickDt, seq: player.lastAppliedSeq }`. The plane keeps cruising forward, which is the right default for a constant-forward arcade flight model.

## 3. `spawnProjectiles()`

For each player whose latest applied input had `fire=true`:

```ts
function tryFire(player: ServerPlayer, now: number): void {
  if (!player.alive) return;
  if (now - player.lastShotAt < PROJECTILE.COOLDOWN_SEC * 1000) return;
  player.lastShotAt = now;

  const forward = forwardFromQuat(player.orientation);  // local +Z transformed
  const noseOffset = PLAYER_NOSE_OFFSET;                // shared constant; matches frontend's plane.noseOffset
  const proj: ServerProjectile = {
    id: ids.nextProjectileId(),
    ownerId: player.id,
    position: addV(player.position, scaleV(forward, noseOffset)),
    velocity: scaleV(forward, PROJECTILE.SPEED),
    spawnTick: room.tick,
    ttl: PROJECTILE.LIFETIME_SEC,
    alive: true,
  };
  room.projectiles.set(proj.id, proj);
  room.eventsBuffer.spawns.push({
    tick: room.tick,
    projectileId: proj.id,
    ownerId: player.id,
    position: { ...proj.position },
    velocity: { ...proj.velocity },
  });
}
```

Note: `PLAYER_NOSE_OFFSET` is the only piece of frontend bbox math the server needs. We freeze it as a shared constant so the server doesn't have to load the GLB to compute it. (See ["Open question"](#open-questions) — alternatively the server can simply spawn at `player.position` and accept ~1 m offset error.)

## 4. `stepProjectiles(dt)`

Identical to the client's [`updateProjectileSystem`](../../frontend/src/game/systems/projectileSystem.ts:31) integrate path:

```ts
for (const p of room.projectiles.values()) {
  p.ttl -= dt;
  if (p.ttl <= 0) {
    despawn(p, 'expired');
    continue;
  }
  p.position.x += p.velocity.x * dt;
  p.position.y += p.velocity.y * dt;
  p.position.z += p.velocity.z * dt;

  // Ground despawn
  if (p.position.y <= 0) despawn(p, 'hit-ground');
}
```

## 5. `detectHits()`

The simple model for v1:

### 5a. Projectile vs player (sphere-vs-sphere)

```ts
const r2 = (NET.HIT_RADIUS_PLAYER + NET.HIT_RADIUS_PROJECTILE) ** 2;
for (const p of projectiles) {
  if (!p.alive) continue;
  for (const target of players) {
    if (!target.alive) continue;
    if (target.id === p.ownerId) continue;            // no self-damage
    if (now < target.immunityUntil) continue;
    if (sqDist(p.position, target.position) > r2) continue;

    target.lives  = Math.max(0, target.lives - NET.PROJECTILE_DAMAGE);  // 1
    target.hp     = target.lives;
    target.immunityUntil = now + PLAYER.IMMUNITY_SEC * 1000;

    room.eventsBuffer.hits.push({
      tick: room.tick, victimId: target.id, attackerId: p.ownerId,
      projectileId: p.id, position: { ...p.position }, livesLeft: target.lives,
    });

    despawn(p, 'hit-player');

    if (target.lives <= 0) {
      target.alive = false;
      target.pendingRespawnAt = now + DEATH.RESPAWN_DELAY_SEC * 1000;
      room.eventsBuffer.deaths.push({
        tick: room.tick, victimId: target.id, attackerId: p.ownerId,
        position: { ...target.position },
      });
    }
    break;   // one bullet, one victim
  }
}
```

Trade-offs and rationale are in [`06_HIT_REGISTRATION.md`](06_HIT_REGISTRATION.md). The short version: this is **server-current-time** detection — no rewind, no lag compensation. Fine for LAN; v2 will rewind targets by `INTERP_DELAY_MS + RTT/2` of the firing player.

### 5b. Plane vs city (delegate to client for v1)

The procedural city is generated identically on every client *and* the server from `WELCOME.citySeed` (already a deterministic [`mulberry32`](../../frontend/src/utils/rng.ts)). The server *can* run the same per-cell AABB collision the client does ([`playerCollisionSystem.ts`](../../frontend/src/game/systems/playerCollisionSystem.ts:53)) but for v1 we keep this **client-side** for the local player — the city geometry is forgiving and the player crashing into a building is largely a single-player concern (no PvP impact). If a client lies about not crashing, the only consequence is they look magic for one round.

If/when this becomes an exploit, the server-side port is straightforward: build the same `cellLookup: Map<string, BuildingAABB[]>` at room init by deserializing the same city seed; reuse the existing `sqDistPointAabb` helper.

## 6. `resolveDeaths()`

Bookkeeping only (the actual decrement happened in `detectHits`). Used to:

- Make sure dead players' inputs are dropped from `applyInputs` (already covered by the `if (!player.alive)` guard).
- Stop projectile cooldown from advancing while dead.
- Schedule respawn (`pendingRespawnAt` is already set during the kill).

## 7. `resolveRespawns()`

```ts
for (const player of players) {
  if (player.alive) continue;
  if (player.pendingRespawnAt === null) continue;
  if (now < player.pendingRespawnAt) continue;

  const spawn = room.spawnPicker.choose(players);   // see 07_ROOMS_AND_LIFECYCLE.md
  player.position    = { ...spawn.position };
  player.orientation = { ...spawn.orientation };
  player.velocity    = { x: 0, y: 0, z: 0 };
  player.alive       = true;
  player.lives       = PLAYER.MAX_LIVES;
  player.hp          = PLAYER.MAX_LIVES;
  player.immunityUntil = now + PLAYER.IMMUNITY_SEC * 1000;
  player.pendingRespawnAt = null;

  room.eventsBuffer.respawns.push({
    tick: room.tick, playerId: player.id,
    position: { ...spawn.position }, orientation: { ...spawn.orientation },
  });
}
```

In v1, **the client-side death system stops being authoritative**. The button in [`deathSystem.ts`](../../frontend/src/game/systems/deathSystem.ts) becomes "request respawn now" (an explicit message — but for v1 we just auto-respawn after `DEATH.RESPAWN_DELAY_SEC` on the server, and the client's modal becomes a "respawning in 2 s…" countdown driven off `serverTimeNow()`). Cleaner handoff, less round-trip flicker.

## 8. `enforceWorldBounds()`

Same clamps as [`planeController.ts`](../../frontend/src/game/systems/planeController.ts:163): `WORLD_FLOOR_Y`, `WORLD_CEIL_Y`, `±WORLD_HALF_SIZE`. Server applies them after physics; the client also applies them locally during prediction so the predicted position never disagrees with the server enough to require a snap.

## 9. `maybeEmitSnapshot()`

Snapshot emission runs on its own accumulator inside the tick loop, decoupled from tick rate:

```ts
let snapshotAcc = 0;
function tick() {
  // ... 1..8 above ...
  snapshotAcc += NET.SERVER_TICK_MS;
  if (snapshotAcc >= NET.SNAPSHOT_MS) {
    emitSnapshot();
    snapshotAcc -= NET.SNAPSHOT_MS;
  }
}
```

`emitSnapshot()`:

```ts
function emitSnapshot(): void {
  const payload: SnapshotPayload = {
    tick: room.tick,
    serverTimeMs: getServerTimeMs(),
    players: [...players.values()].map(toSnapshotPlayer),
    projectiles: [...projectiles.values()].filter(p => p.alive).map(toSnapshotProjectile),
    acks: [...players.values()].map(p => ({ id: p.id, seq: p.lastAppliedSeq })),
    events: drainEventsBuffer(),    // moves accumulated events into payload, clears buffer
  };
  io.to(ROOM_ID).emit('snapshot', payload);
}
```

Events are buffered tick-by-tick and **drained on snapshot emission**, not on tick. This is intentional: a `hits` event that happens on tick 12 will fly out on the snapshot at tick 13 or 14 (whichever first). The client's interpolation timeline is at `serverTimeNow() − 100 ms` so events are surfaced *after* the corresponding visual state, which is the right ordering for hit sounds + flash.

## Pseudocode of one full tick

```ts
function tick(): void {
  const now = getServerTimeMs();
  room.tick++;

  // 1+2 inputs + physics
  for (const player of players.values()) {
    const inputs = drainInputs(player);
    if (inputs.length === 0 && player.alive) {
      applyPlaneInput(player, IDLE_INPUT, NET.SERVER_TICK_MS / 1000);
    } else {
      for (const i of inputs) {
        applyPlaneInput(player, i, i.dt);
        player.lastAppliedSeq = i.seq;
        if (i.fire) tryFire(player, now);
        // i.dodge handled identically inside applyPlaneInput
      }
    }
  }

  // 4 projectiles
  for (const p of projectiles.values()) {
    if (!p.alive) continue;
    p.ttl -= NET.SERVER_TICK_MS / 1000;
    if (p.ttl <= 0) { despawn(p, 'expired'); continue; }
    integrateProjectile(p, NET.SERVER_TICK_MS / 1000);
    if (p.position.y <= 0) despawn(p, 'hit-ground');
  }

  // 5 hits
  detectProjectileVsPlayerHits(now);

  // 6+7 deaths/respawns
  resolveDeathsAndRespawns(now);

  // 8 bounds
  for (const player of players.values()) clampToWorld(player);

  // 9 snapshot
  snapshotAcc += NET.SERVER_TICK_MS;
  if (snapshotAcc >= NET.SNAPSHOT_MS) {
    emitSnapshot();
    snapshotAcc -= NET.SNAPSHOT_MS;
  }
}
```

## Determinism guarantees we rely on

- `applyPlaneInput`, `integrateProjectile`, and `clampToWorld` use only their inputs + `packages/shared/config.ts` constants. No `Date.now()`, no `Math.random()` (RNG goes through the seeded `mulberry32` from [`frontend/src/utils/rng.ts`](../../frontend/src/utils/rng.ts), eventually hoisted to `packages/shared`).
- `Quaternion.normalize` is called at the end of every orientation update (matches client's [`_orient.normalize()`](../../frontend/src/game/systems/planeController.ts:103)).
- Float `dt` is **always** `i.dt` from the input or the fixed `NET.SERVER_TICK_MS / 1000`. Never wall-clock-derived. (Wall clock determines *when* a tick fires, not what dt the simulation uses.)

These three guarantees together mean: with identical inputs and seed, client prediction and server simulation produce bit-identical positions. Reconciliation then only needs to fire when an input was *missed* on the server (lost, or arrived after its tick boundary).

## Open questions

- **Where does the nose offset live?** Today [`createPlane`](../../frontend/src/entities/plane.ts:21) computes it from the GLB bbox. The server has no GLB. Options: (a) hard-code `PLAYER_NOSE_OFFSET = 3.5` in shared config (simplest, tied to the `PLAYER_LENGTH = 6` constant in [`plane.ts`](../../frontend/src/entities/plane.ts:6)); (b) the client sends its measured nose offset in `hello` and the server uses that for that player's bullets only (allows model variants like `angelic-tung-tung.glb`). v1: pick (a).
- **Should city collision become server-authoritative?** Filed as v2.
- **Variable input rate.** Dropping below 30 Hz from a poor connection means we synthesize `IDLE_INPUT` ticks on the server, which makes the plane drift forward at last-known turbo. Client prediction will diverge; reconciliation will snap. Acceptable for v1.
