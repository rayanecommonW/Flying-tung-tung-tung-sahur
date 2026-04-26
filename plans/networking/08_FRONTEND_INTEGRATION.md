# Networking — 08 — Frontend Integration

This doc translates the abstract algorithms from the rest of this folder into a concrete plan for what files to add to [`frontend/src/`](../../frontend/src/), what to change in existing files, and how data flows through the loop. The constraint from [`plans/01_ARCHITECTURE.md`](../01_ARCHITECTURE.md) — "PvP only needs to touch a small set of files" — is what we'll deliver against.

## New folder: `frontend/src/net/`

```
frontend/src/net/
├── socket.ts          // wraps socket.io-client; exposes a typed emit/on
├── clock.ts           // startClockSync, serverTimeNow — see 02_CLOCK_SYNC.md
├── prediction.ts      // input ring buffer, reconcile() — see 04_CLIENT_PREDICTION.md
├── interpolation.ts   // remote buffers + interpolateRemotes() — see 05_INTERPOLATION.md
├── netSystem.ts       // top-level: owns NetState, wires everything, exposed to gameLoop
└── netState.ts        // shared NetState shape (mirrors Garama's GameState.net)
```

### `socket.ts`

A thin wrapper over `socket.io-client`'s `Socket`. Two responsibilities:

1. Expose a connect/disconnect API that returns a typed object instead of a `Socket` directly, so the rest of the code can't accidentally `socket.emit('foo', ...)` with a typo.
2. Provide an `emit<E extends EventName>(name: E, payload: Payloads[E])` helper using the discriminated-union types in [`packages/shared/src/events.ts`](../../packages/shared/src/events.ts).

```ts
// frontend/src/net/socket.ts (sketch)
import { io, type Socket } from 'socket.io-client';
import type {
  EVENTS, HelloPayload, WelcomePayload, PingPayload, PongPayload,
  InputPayload, SnapshotPayload, PlayerJoinedPayload, PlayerLeftPayload,
  KickedPayload,
} from '@flying-tung-tung/shared';

export interface TypedSocket {
  raw: Socket;
  emit:
    & ((e: typeof EVENTS.HELLO,  p: HelloPayload)  => void)
    & ((e: typeof EVENTS.PING,   p: PingPayload)   => void)
    & ((e: typeof EVENTS.INPUT,  p: InputPayload)  => void);
  on:
    & ((e: typeof EVENTS.WELCOME,       cb: (p: WelcomePayload)       => void) => void)
    & ((e: typeof EVENTS.PONG,          cb: (p: PongPayload)          => void) => void)
    & ((e: typeof EVENTS.SNAPSHOT,      cb: (p: SnapshotPayload)      => void) => void)
    & ((e: typeof EVENTS.PLAYER_JOINED, cb: (p: PlayerJoinedPayload)  => void) => void)
    & ((e: typeof EVENTS.PLAYER_LEFT,   cb: (p: PlayerLeftPayload)    => void) => void)
    & ((e: typeof EVENTS.KICKED,        cb: (p: KickedPayload)        => void) => void);
  disconnect(): void;
}

export function createSocket(url: string): TypedSocket { /* ... */ }
```

Don't over-engineer this; the wrapper exists purely so the call sites are `socket.emit(EVENTS.INPUT, payload)` with full inference.

### `netState.ts`

```ts
import type { Vec3, Vec4, PlayerState, ProjectileState } from '@flying-tung-tung/shared';

export interface NetState {
  // ===== Connection =====
  connected: boolean;
  selfId: string | null;                 // populated by WELCOME
  protocolVersion: number;

  // ===== Clock =====
  clockOffsetMs: number;
  smoothedRttMs: number;
  lastSnapshotServerTimeMs: number | null;
  lastSnapshotClientRecvMs: number | null;

  // ===== Remote interpolation buffers =====
  remotePlayerBuffers:     Map<string, RemotePlayerSample[]>;
  remoteProjectileBuffers: Map<number, RemoteProjectileSample[]>;

  // ===== Local-player prediction =====
  inputRing: PendingInput[];
  nextInputSeq: number;
  lastAckedSeq: number;

  // ===== UI/debug =====
  recentHits: Array<{ tick: number; victimId: string; at: number }>;  // for HUD flash
  kickedReason: KickedPayload | null;
}
```

`createNetState()` returns the empty initial value.

### `netSystem.ts` — the integration point

```ts
// frontend/src/net/netSystem.ts (sketch)
import type { GameState } from '../game/gameState';
import { createSocket } from './socket';
import { startClockSync, serverTimeNow } from './clock';
import { reconcile, sendInputForCurrentTick } from './prediction';
import { ingestSnapshot, interpolateRemotes } from './interpolation';
import { EVENTS } from '@flying-tung-tung/shared';

export interface NetSystem {
  net: NetState;
  isReady: boolean;
  shutdown(): void;
}

export function startNetSystem(state: GameState, serverUrl: string, playerName: string): NetSystem {
  const net = createNetState();
  const socket = createSocket(serverUrl);
  let stopClock: (() => void) | undefined;

  socket.raw.on('connect', () => {
    socket.emit(EVENTS.HELLO, {
      name: playerName,
      protocolVersion: PROTOCOL_VERSION,
      clientTimeMs: performance.now(),
    });
    stopClock = startClockSync(socket, net).stop;
  });

  socket.on(EVENTS.WELCOME, (msg) => {
    net.selfId = msg.playerId;
    state.player.id = msg.playerId;
    state.player.position = { ...msg.spawn.position };
    state.player.orientation = { ...msg.spawn.orientation };
    state.citySeed = msg.citySeed;          // already exists from buildCity, just align
    // Pre-create remote-plane entities from msg.others[] so the first frame
    // of interpolation doesn't gate on a snapshot.
    for (const o of msg.others) addRemotePlayer(state, o);
  });

  socket.on(EVENTS.SNAPSHOT, (msg) => {
    ingestSnapshot(msg, net, state);        // updates buffers + stepwise scalars
    reconcile(msg, state, net);             // local-plane reconciliation
  });

  socket.on(EVENTS.PLAYER_JOINED, (msg) => addRemotePlayer(state, msg.player));
  socket.on(EVENTS.PLAYER_LEFT,   (msg) => removeRemotePlayer(state, msg.id));
  socket.on(EVENTS.KICKED,        (msg) => { net.kickedReason = msg; socket.disconnect(); });

  return {
    net,
    get isReady() { return net.connected && net.selfId !== null; },
    shutdown: () => { stopClock?.(); socket.disconnect(); },
  };
}

// Called from gameLoop's update path AFTER updatePlaneController.
export function netUpdate(state: GameState, net: NetState, localTickIndex: number): void {
  if (net.connected && net.selfId) {
    // Send every other 60 Hz tick = 30 Hz upload.
    if (localTickIndex % 2 === 0) sendInputForCurrentTick(state, net);
  }
}

// Called from gameLoop's render path BEFORE renderer.render(...).
export function netRender(state: GameState, net: NetState): void {
  interpolateRemotes(state, net);
}
```

## Changes to existing files

### [`frontend/src/main.ts`](../../frontend/src/main.ts)

```diff
+ import { startNetSystem, netUpdate, netRender } from './net/netSystem';
+ import { applyRemotePoses } from './entities/plane';

  const state = createGameState();
+ const playerName = prompt('Pilot name?') ?? 'Tung';                // v1: cheap UX
+ const netSys = await startNetSystem(state, 'http://localhost:3001', playerName);

  startGameLoop({
    update: (dt) => {
      state.time += dt;
      updatePlaneController(state, dt);
      updateProjectileSystem(state, plane, pmesh, trail, dt);
-     updateCollisionSystem(state, city, trail);                     // moves to "local-only visual" (see below)
-     updatePlayerCollisionSystem(state, city, trail);               // local-only visual until v2
      updateDeathSystem(state, plane, canvas);
+     netUpdate(state, netSys.net, ++localTickIndex);                // emits 'input' at 30 Hz
      updateCameraSystem(camera, state, dt);
      updateParticleSystem(state, plane, trail, dt);
      if (!state.player.dead) applyPose(plane, state.player);
+     applyRemotePoses(state.remotePlanes, state.remotePlayers);
      // ...
    },
    render: () => {
+     netRender(state, netSys.net);                                  // interpolates remote buffers
      renderer.render(scene, camera);
    },
  });
```

`localTickIndex` is just a counter. Initial frames before `WELCOME` arrives — the netSystem's `isReady` is false; `netUpdate` no-ops.

### [`frontend/src/game/gameState.ts`](../../frontend/src/game/gameState.ts)

Add fields for remote players + remote projectiles, and the city seed:

```ts
export interface RemotePlayer extends PlayerState {
  // PlayerState already has all the pose + scalar fields we need.
  // We add a Three.Group reference at the entity layer, not here.
}

export interface RemoteProjectile {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  ttl: number;
  // Note: rendering uses the existing InstancedMesh pool. Each remote-projectile
  // gets a slot index assigned on first appearance.
}

export interface GameState {
  // ... existing ...
  remotePlayers: Map<string, RemotePlayer>;
  remoteProjectiles: Map<number, RemoteProjectile>;
  citySeed: number;        // populated from WELCOME.citySeed; used by buildCity
}
```

`createGameState()` initializes both as empty `Map`s.

### [`frontend/src/entities/plane.ts`](../../frontend/src/entities/plane.ts)

Add a helper that creates a remote-plane entity (a *new* `THREE.Group` for each remote player):

```ts
// reuses the existing PlaneEntity shape; the model GLB is loaded once and shared
// via Object3D.clone() for cheap per-player instantiation
export async function createRemotePlane(modelUrl: string): Promise<PlaneEntity> { /* clone path */ }

// Apply each remote-plane state to its mesh — same math as applyPose, but for many.
export function applyRemotePoses(planes: Map<string, PlaneEntity>, players: Map<string, RemotePlayer>): void { /* ... */ }
```

### Existing systems: which stay, which become "client-only visual"

| File | Status under multiplayer | Why |
|------|--------------------------|-----|
| [`planeController.ts`](../../frontend/src/game/systems/planeController.ts) | **Stays** — drives local prediction. Refactored to call shared `applyPlaneInput`. | The local plane must still feel instant. |
| [`projectileSystem.ts`](../../frontend/src/game/systems/projectileSystem.ts) | **Replaced for the local pool.** Keep the InstancedMesh + pool, but the spawn/despawn signals come from `events.spawns` / `events.despawns` in snapshots, not local clicks. The integrate-and-age loop becomes a *render-time* interpolation off the buffer. | Server is authoritative for projectiles. |
| [`collisionSystem.ts`](../../frontend/src/game/systems/collisionSystem.ts) | **Local-only visual.** Lets local bullets visually stop on buildings even though the server's authoritative bullet might pass through. Keep until v2 makes the server city-aware. | Removes ugly "bullet visibly clips wall" without server work. |
| [`playerCollisionSystem.ts`](../../frontend/src/game/systems/playerCollisionSystem.ts) | **Stays for the local plane** in v1 — the server doesn't know city geometry. Damage applied locally via the existing `lives` decrement, but the **server's snapshot will overwrite `lives`** every 50 ms. So locally-detected deaths only "stick" if the server agrees. | Compromise: city-collision-driven death is single-player only in v1. |
| [`deathSystem.ts`](../../frontend/src/game/systems/deathSystem.ts) | **Refactored.** Death is now driven by `events.deaths[victimId == selfId]` from the server. The respawn modal becomes a `serverTimeNow()`-based countdown. The button becomes "request immediate respawn" but for v1 it just hides itself when the server respawns us automatically. | Prevents two competing death paths. |
| [`cameraSystem.ts`](../../frontend/src/game/systems/cameraSystem.ts) | **Stays unchanged.** | Pure local concern. |
| [`particleSystem.ts`](../../frontend/src/game/systems/particleSystem.ts) | **Stays.** Trail is local; bursts are now triggered from `events.hits` / `events.despawns` instead of local `playerCollisionSystem`. | Visual-only. |
| [`hudSystem.ts`](../../frontend/src/game/systems/hudSystem.ts) | **Extended** to display ping/RTT, player count, score. | Pure local concern. |

### Updated update-order in `gameLoop.update(dt)`

```
1.  state.time += dt
2.  updatePlaneController(state, dt)          // local prediction; mutates state.player
3.  updateProjectileSystem(state, ...)         // LOCAL trail/spawn cosmetic only — server is truth
4.  updateCollisionSystem(state, city, ...)    // local visual: stop bullets on walls
5.  updatePlayerCollisionSystem(...)           // local visual: city-vs-plane death (v1 only)
6.  updateDeathSystem(state, plane, canvas)    // now server-driven; modal is a countdown
7.  netUpdate(state, net, tickIdx)             // 30 Hz input emit
8.  updateCameraSystem(camera, state, dt)
9.  updateParticleSystem(state, plane, ..., dt)
10. applyPose(plane, state.player)             // local pose
11. applyRemotePoses(remotePlanes, remotePlayers)
12. updateHud(state)
```

In `gameLoop.render(alpha)`:

```
1.  netRender(state, net)                      // interpolate remote buffers into RemotePlayer / RemoteProjectile maps
2.  renderer.render(scene, camera)
```

The interpolation runs in the render path so it's 60 Hz, not 60-Hz-but-clamped-to-fixed-step. `applyRemotePoses` is in the update path so the camera (which depends on plane positions) sees consistent values; remote-plane interpolated fields will be one render frame stale relative to the camera, which is invisible at 60 Hz.

## Loading-screen + bootstrapping change

Before networking: bootstrap loads assets, generates the city, starts the loop.

With networking the order changes slightly:

1. Bootstrap loads assets (no change).
2. Show "Connecting…" loading message.
3. `startNetSystem(state, url, name)` connects → `welcome` arrives → city seed known.
4. `buildCity(scene, lib, state.citySeed)` runs (was previously seeded by [`CITY.SEED`](../../packages/shared/src/config.ts:91); now overridable from server).
5. Start loop.

(If we want offline/single-player as a fallback, gate on a connection timeout: 3 s no `welcome` → fall back to current single-player path with `CITY.SEED`. Optional v1 polish.)

## What the player perceives differently

- 1-second pause at the loading screen for clock-sync handshake.
- "Click-to-bullet" is ~RTT/2 + half-snapshot late (60–150 ms on LAN).
- Lives decrement on a 100 ms-late snapshot rather than instantly when crashing into a building (v1 keeps local building death instant, server reconciles).
- A second tab in the same browser shows the player's own plane through interpolation (because each tab is a separate "self"). They'll see two planes flying.

## Reasoning for keeping `state.player` local-and-mutable

The simplest mental model is: `state.player` is the **predicted local player** — what the local client thinks the local plane is doing right now. The server's view of the local player is in `net.lastAckedSelfState` (or just `snapshot.players[selfId]` peeked at receive time). Keeping the existing single field for the local plane means [`applyPose`](../../frontend/src/entities/plane.ts:68), [`updatePlaneController`](../../frontend/src/game/systems/planeController.ts:50), and the camera don't need to know networking exists.

The `Map<id, RemotePlayer>` for non-local players is a separate code path. This avoids the "is `state.player` predicted or interpolated?" footgun.
