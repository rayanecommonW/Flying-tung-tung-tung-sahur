# Networking — 04 — Client Prediction & Reconciliation

The local plane must feel **instant**. Mouse move → plane tilts → screen reflects it the same frame. Anything else feels broken in a flight game where the player is constantly steering. But the server is authoritative, and snapshots arrive 100+ ms late and only at 20 Hz. The bridge between those two truths is **client-side prediction with server reconciliation**.

This is standard Quake/Source-engine technology, well-documented in [Gambetta's series](https://gabrielgambetta.com/client-server-game-architecture.html). What's specific to Flying Tung Tung:

- The local plane is **already** simulated client-side at 60 Hz today ([`updatePlaneController`](../../frontend/src/game/systems/planeController.ts:50)). Prediction is a re-purposing of that loop — not new physics.
- The shared math (in `packages/shared/src/sim/applyPlaneInput.ts` after the refactor in [`03_SERVER_SIM.md`](03_SERVER_SIM.md)) means client prediction and server simulation are **bit-identical** given identical inputs. Reconciliation only fires when inputs are lost in transit, not because of float drift.

## Goal

The local player's plane:

- Moves at 60 Hz with zero perceptible input lag.
- **Never rubber-bands** under normal network conditions (no packet loss).
- **Smoothly snaps** to server truth when a real desync happens (e.g. server clipped us through a building; we got hit and lost a life).

Remote players' planes do **not** use prediction — they use interpolation. See [`05_INTERPOLATION.md`](05_INTERPOLATION.md).

## High-level flow

```
   60 Hz tick (frontend)                 30 Hz network                    server
   ──────────────────                    ─────────────                    ─────────────
   read input → produce InputPayload                                       
   - apply locally (predicted) ──┐                                         
   - push into ring buffer        │                                        
                                  │  (every 2nd local tick:)              
                                  └──► emit('input', payload) ──────────► appended to inputQueue
                                                                          drained next server tick
                                                                          applyPlaneInput(player, …)
                                                                          ackedSeq = payload.seq
                                                                          (in next snapshot)
   on snapshot for self:                                                  
     - server says my pos/quat at tick T was X                            
     - look up my predicted state at the same input.seq                   
     - if very close → keep predicted (no jitter)                         
     - if slightly off → smooth-correct (lerp/slerp toward X)             
     - if very off    → snap to X, replay all inputs > ackedSeq            
                       on top of X                                         
```

## Local sub-tick rate vs network send rate

- Client physics still runs at **60 Hz** — `FIXED_DT = 1/60` from [`packages/shared/src/config.ts`](../../packages/shared/src/config.ts:200), unchanged.
- Inputs are sent at **30 Hz** — every other 60 Hz tick.
- One `InputPayload` therefore batches **two** local sub-ticks. The payload's `dt` field is the sum of those two sub-tick dts (= `2 / 60 ≈ 33.33 ms`), and the `axes` are the **most recent** sub-tick's axes (the prior sub-tick's axes are discarded — fine because consecutive sub-ticks of mouse input are nearly identical).

This is a deliberate compromise. Pure 60 Hz inputs would double upstream bandwidth and double server CPU; pure 30 Hz client physics would harm input feel. Batching is the cheapest way to keep both.

## The input ring buffer

```ts
// frontend/src/net/prediction.ts
interface PendingInput {
  seq:      number;        // matches InputPayload.seq sent to server
  payload:  InputPayload;  // the exact bytes we sent
  // The predicted state AFTER applying this input. Used for reconciliation
  // diff computation when the server acks this seq.
  predictedAfter: {
    position:    Vec3;
    velocity:    Vec3;
    orientation: Vec4;
  };
}

const ring: PendingInput[] = [];   // FIFO; bounded by NET.INPUT_BUFFER_RING_SIZE = 128
let nextSeq = 1;
```

Ring size of 128 covers ~2.1 s at 60 Hz, more than enough for any plausible RTT. If the buffer overflows we evict from the head and assume those inputs are lost forever (the server's `lastAppliedSeq` is way behind us — a problem reconciliation will surface).

## Per-tick on the client (60 Hz)

```ts
// in updatePredictedLocalPlayer(state, dt) — replaces parts of updatePlaneController
function tick(state, dt, net): void {
  const input = readInput(state.input, dt);             // build axes, fire, dodge, turbo

  // 1. Apply locally — same shared function the server runs.
  applyPlaneInput(state.player, input, dt);

  // 2. Determine if this tick produces a network send.
  const shouldSend = (++localTickCounter % 2) === 0;
  if (shouldSend) {
    const payload: InputPayload = {
      seq: nextSeq++,
      dt: dt * 2,                                       // we're batching two sub-ticks
      clientTimeMs: performance.now(),
      axes:    input.axes,
      turbo:   input.turbo,
      fire:    input.fire,
      dodge:   input.dodge,
    };
    ring.push({
      seq: payload.seq,
      payload,
      predictedAfter: snapshotPlayer(state.player),     // shallow copy of pos/vel/quat
    });
    if (ring.length > NET.INPUT_BUFFER_RING_SIZE) ring.shift();   // evict oldest
    socket.emit('input', payload);
  }
}
```

## On snapshot arrival: reconciliation

```ts
function reconcile(snapshot: SnapshotPayload, state, net): void {
  const myAck = snapshot.acks.find(a => a.id === state.player.id);
  if (!myAck) return;                                   // server doesn't know us yet
  const ackedSeq = myAck.seq;

  const myServerState = snapshot.players.find(p => p.id === state.player.id);
  if (!myServerState) return;                           // we just died, server cleaned up — handle separately

  // 1. Drop all inputs the server has already applied.
  while (ring.length > 0 && ring[0].seq <= ackedSeq) ring.shift();

  // 2. Find my predicted state AT the moment of ackedSeq.
  //    That's the input WHOSE SEQ matches ackedSeq, whose `predictedAfter` is
  //    what we expected the server to produce. Since we just shifted those
  //    inputs out, we look it up from a parallel "lastAcked" snapshot we
  //    keep — but cheaper: compute the error from current predicted state,
  //    knowing we'll re-simulate the queue.
  const errPos  = distance(myServerState.position, ring[0]?.predictedAfter.position ?? state.player.position);
  // (Or: keep the last shifted entry around and diff against that. See impl note.)

  // 3. Three cases:
  if (errPos < SOFT_THRESHOLD) {
    // 3a. Trust prediction. The server agrees within 0.25 m — just absorb
    //     the new authoritative HP/lives/alive flags, leave pose alone.
    state.player.hp     = myServerState.hp;
    state.player.lives  = myServerState.lives;
    state.player.alive  = myServerState.alive;
    return;
  }

  if (errPos > HARD_THRESHOLD) {
    // 3b. Big desync (probably we missed a hit, or server clipped us).
    //     Snap, replay unacked inputs.
    state.player.position    = { ...myServerState.position };
    state.player.velocity    = { ...myServerState.velocity };
    state.player.orientation = { ...myServerState.orientation };
    state.player.hp          = myServerState.hp;
    state.player.lives       = myServerState.lives;
    state.player.alive       = myServerState.alive;

    for (const pending of ring) {
      applyPlaneInput(state.player, pending.payload, pending.payload.dt);
    }
    return;
  }

  // 3c. Small desync. Soft-correct: target = server pose + replayed inputs,
  //     but lerp toward it instead of snapping.
  const target = clone(myServerState);
  for (const pending of ring) {
    applyPlaneInput(target, pending.payload, pending.payload.dt);
  }
  smoothToward(state.player, target, SMOOTH_RATE);
}
```

## Smoothing thresholds

```ts
const SOFT_THRESHOLD = 0.25;     // metres — trust prediction below this
const HARD_THRESHOLD = 5.0;      // metres — snap above this
const SMOOTH_RATE    = 0.20;     // pos lerp factor per snapshot received
const SMOOTH_QSLERP  = 0.30;     // quat slerp factor per snapshot received
```

`smoothToward` lerps `position` and `velocity` and slerps `orientation`. Because snapshots arrive 20×/s, a `0.20` factor reaches 99 % corrected within ~22 snapshots ≈ 1.1 s — slow enough to be invisible in normal play, fast enough that a real desync resolves before the player can "feel" the wrong position.

## Why these thresholds

- **0.25 m soft.** A plane at cruise (60 m/s) covers 1 m every 17 ms. Small float drift between 30 Hz server and 60 Hz client over a single tick should sit well under this. Anything bigger is "real" desync that demands smoothing.
- **5 m hard.** The plane's collider radius is 1.8 ([`PLANE.COLLIDER_RADIUS`](../../packages/shared/src/config.ts:50)). 5 m means we'd see ourselves on the wrong side of a building or several plane-lengths off course. Snapping is less jarring than continuing to lerp here.

## Why local plane should not rubber-band

If we **always snapped** the local plane to the server's value (no prediction, just interpolate), the player's mouse would feel ~`RTT/2 + INTERP_DELAY_MS ≈ 100–150 ms` late. At plane cruise speed that's **9 m of lag visible to the player** — they feel like they're skating on ice with the controls disconnected. Unplayable.

If we **predicted but never reconciled**, the local view would slowly drift away from the server's truth and we'd pass through buildings without dying / the server would damage us at positions where we're not standing on screen.

Prediction + reconciliation gives us the best of both: instant feel under normal conditions, correct truth when something's actually wrong.

## What we do NOT predict on the local client

- **Hits / damage / lives.** `hp`, `lives`, and `alive` are pulled directly from snapshots. Speculatively decrementing on a "I think I got shot" client-side hint causes flicker. Just wait the ~50 ms for the snapshot.
- **Projectile spawns from the local plane.** This is the main *visual* compromise. When the local player clicks fire at client time `t0`, the bullet appears in their world only when the next snapshot containing the corresponding `events.spawns` entry arrives — `t0 + RTT/2 + (snapshot accumulator delay) + INTERP_DELAY_MS`. That's ~60–150 ms of "click-to-bullet-visible" latency.

  For v1 we accept this. v2 can spawn a **predicted local-only projectile** the instant the input fires, then merge with the server-spawned authoritative projectile when its `events.spawns` lands. Garama doesn't predict its sword swings either — same trade-off.

- **Other players' planes.** Their state is interpolated, period.

## Edge cases

- **Server died / packet loss / no acks for >1 s.** `ring` grows toward 128. We stop sending new inputs after that (no point — they'll just evict). The plane keeps predicting forward; remote planes start to extrapolate (see [`05_INTERPOLATION.md`](05_INTERPOLATION.md)). When packets resume, we replay everything still in the ring.
- **Local player was killed.** `myServerState.alive === false` arriving while we still think we're alive: snap to dead, run the death/respawn flow per [`07_ROOMS_AND_LIFECYCLE.md`](07_ROOMS_AND_LIFECYCLE.md). Clear the ring (no point predicting a dead plane's flight).
- **We just respawned.** `events.respawns[selfId]` lands with a new pose — snap, clear ring, start predicting fresh. Don't try to "smooth from where we died to where we respawned".
- **Initial join, before any ack.** Server sends `WELCOME.spawn`; client snaps the plane there and starts inputting. The first snapshot's ack will be `seq = 0`, meaning "I have applied no inputs from you yet". Reconciliation just absorbs HP/alive and leaves pose alone. This is fine.

## File responsibilities

```
frontend/src/net/prediction.ts
  - the ring buffer + nextSeq counter
  - reconcile(snapshot, state, net) function
  - export PRED_SOFT_THRESHOLD, PRED_HARD_THRESHOLD, PRED_SMOOTH_RATE
  - depends on shared/sim/applyPlaneInput.ts
```

`frontend/src/game/gameLoop.ts` change: after `updatePlaneController(state, dt)` (which now wraps `applyPlaneInput`), the netSystem checks `localTickCounter % 2` and pushes/sends. On snapshot receive, `netSystem` calls `reconcile()` before the next render.
