# Networking — 02 — Clock Synchronization

The client and the server keep different clocks (`performance.now()` vs `process.uptime() * 1000`), and the network adds variable one-way latency. Almost every other system in this folder — interpolation, prediction reconciliation, lag compensation — relies on the client being able to answer **"what is the server's clock value, right now?"** without round-tripping. That answer is what clock sync produces.

This algorithm is lifted from Garama's [`clockSync.ts`](../../../Garama/frontend/src/game/net/clockSync.ts) (which itself follows [Valve's "Source Multiplayer Networking"](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) and Gambetta's writeup). The only adaptations are:

- `K = 5` initial samples (Garama uses 8) — see [`00_OVERVIEW.md`](00_OVERVIEW.md).
- The interp-delay derivation is **fixed at 100 ms** rather than RTT-derived. We're not playing on the public internet in v1; clamping interp-delay to RTT-based values is a future polish.

## What we compute

Two scalar fields stored on the client's `NetState` (defined in [`08_FRONTEND_INTEGRATION.md`](08_FRONTEND_INTEGRATION.md)):

| Field | Units | Meaning |
|-------|-------|---------|
| `clockOffsetMs` | ms | `serverTimeMs ≈ clientTimeMs + clockOffsetMs` |
| `smoothedRttMs` | ms | EMA-smoothed round-trip time |

…and one derived helper:

```ts
function serverTimeNow(net: NetState): number {
  return performance.now() + net.clockOffsetMs;
}
```

`serverTimeNow()` is the client's best estimate of the *server's current* `serverTimeMs`. It is the reference timeline for both prediction reconciliation and remote-plane interpolation.

## Why we need it (concretely)

- **Interpolation** ([`05_INTERPOLATION.md`](05_INTERPOLATION.md)) renders remote planes at `serverTimeNow() − INTERP_DELAY_MS`. If the offset is wrong by 50 ms, the buffer windows are wrong, and remote planes either rubber-band (offset too positive → render in the future, run out of samples) or stutter (offset too negative → render too far in the past, sit on stale samples).
- **Prediction reconciliation** ([`04_CLIENT_PREDICTION.md`](04_CLIENT_PREDICTION.md)) maps the latest snapshot's `serverTimeMs` back into client time to know which input.seq was inflight when the server published. We use `acks[selfId].seq` for that, but `serverTimeMs` is the cross-check that catches "snapshot from 200 ms ago" as a stale-event source.
- **Future lag compensation** ([`06_HIT_REGISTRATION.md`](06_HIT_REGISTRATION.md)) needs `serverTimeNow() − RTT/2 − INTERP_DELAY_MS` to know when the firing client *saw* the world.

## Algorithm at a glance

```
┌─────────── on connect ──────────┐  ┌──────── every 1 s after ────────┐
│  1. Fire 5 PINGs, 200 ms apart  │  │  Fire 1 PING                    │
│  2. Drop RTT outliers > med+σ   │  │  Update offset/RTT via EMA      │
│  3. Set offset = mean(filtered) │  │  If drift > 80 ms or RTT spike  │
│  4. Set smoothedRtt = mean      │  │  > 180 ms → re-run initial sync │
└─────────────────────────────────┘  └─────────────────────────────────┘
```

## Initial sync (handshake)

Triggered by `socket.on('connect')` after the connection is up and `WELCOME` has been received. (The first `WELCOME.serverTimeMs` is *not* used directly — it's a single sample with unknown one-way delay, which is exactly what we're trying to measure.)

```ts
// pseudocode, lives in frontend/src/net/clock.ts
async function runInitialSync(socket: Socket, net: NetState): Promise<void> {
  const samples: { rttMs: number; offsetMs: number }[] = [];

  for (let i = 0; i < NET.CLOCK_SYNC_INITIAL_SAMPLES; i++) {   // 5
    const sample = await pingOnce(socket);                      // see below
    if (sample) samples.push(sample);
    await sleep(NET.CLOCK_SYNC_PAUSE_MS);                       // 200
  }

  const filtered = dropRttOutliers(samples);                    // > median + 1σ
  if (filtered.length === 0) return;                            // network is bad; try maintenance later

  net.clockOffsetMs = mean(filtered.map((s) => s.offsetMs));
  net.smoothedRttMs = mean(filtered.map((s) => s.rttMs));
}
```

Total handshake duration: `5 × 200 ms = ~1 second` of join-time clock-sync, plus whatever RTT each sample takes. That's the one-time cost paid before the world starts simulating remote planes meaningfully.

### `pingOnce`: one round-trip, one sample

```ts
async function pingOnce(socket: Socket): Promise<{ rttMs: number; offsetMs: number } | null> {
  const sentAt = performance.now();
  socket.emit('ping', { clientSendTimeMs: sentAt } satisfies PingPayload);

  const pong = await waitForPong(socket, /* timeout */ 1500);
  if (!pong) return null;                       // socket dropped or 1.5 s timeout

  const recvAt   = performance.now();
  const rttMs    = recvAt - sentAt;             // round-trip
  const oneWayUp = rttMs / 2;                   // assume symmetric (the simplest unbiased estimator)
  const estServerNowAtRecv = pong.serverTimeMs + oneWayUp;
  const offsetMs = estServerNowAtRecv - recvAt; // serverTime - clientTime
  return { rttMs, offsetMs };
}
```

### Outlier rejection

Symmetric one-way latency is an OK assumption for the *median* RTT but very bad for spikes (TCP retransmits, OS scheduler hiccups, browser GC pauses). We drop the worst:

```ts
function dropRttOutliers(samples: Sample[]): Sample[] {
  if (samples.length <= 2) return samples;
  const rtts = samples.map((s) => s.rttMs);
  const cutoff = median(rtts) + stdDev(rtts);
  return samples.filter((s) => s.rttMs <= cutoff);
}
```

(Lifted verbatim from [`Garama/frontend/src/game/net/clockSync.ts`](../../../Garama/frontend/src/game/net/clockSync.ts:57).)

## Maintenance loop

After initial sync, we ping at 1 Hz forever. Each pong feeds an EMA so transient jitter doesn't yank the offset around:

```ts
const ALPHA = NET.CLOCK_SYNC_EMA_ALPHA;          // 0.12

function applyMaintenanceSample(sample, net) {
  const driftMs    = Math.abs(sample.offsetMs - net.clockOffsetMs);
  const rttSpikeMs = sample.rttMs - net.smoothedRttMs;

  net.clockOffsetMs = ALPHA * sample.offsetMs + (1 - ALPHA) * net.clockOffsetMs;
  net.smoothedRttMs = ALPHA * sample.rttMs    + (1 - ALPHA) * net.smoothedRttMs;

  // If something big shifted (tab woke up, network changed, server restart), redo the K-sample sync.
  if (driftMs    > NET.CLOCK_SYNC_DRIFT_RESYNC_MS  ||      // 80
      rttSpikeMs > NET.CLOCK_SYNC_RTT_SPIKE_MS) {          // 180
    void runInitialSync(socket, net);
  }
}
```

`ALPHA = 0.12` means each new sample contributes 12 % to the running average — a 90 % rise time of ~18 samples ≈ 18 seconds at 1 Hz. Slow enough to ignore single-packet jitter, fast enough to follow real network changes.

## Sequence diagram (initial sync)

```
client                                                         server
  |                                                                 |
  |  [t0] ── ping {clientSendTimeMs: t0} ─────────────────────────► |
  |                                                                 |   serverSeesAt = serverTimeMs()
  |  ◄────────────── pong {clientSendTimeMs: t0,                    |
  |                  serverTimeMs: serverSeesAt} [t1]               |
  |                                                                 |
  |  rtt        = t1 - t0                                           |
  |  estServer  = serverSeesAt + rtt/2                              |
  |  offset     = estServer - t1                                    |
  |                                                                 |
  |  (sleep 200 ms)                                                 |
  |  ── ping ─►  ... ◄── pong  (sample 2)                           |
  |  ── ping ─►  ... ◄── pong  (sample 3)                           |
  |  ── ping ─►  ... ◄── pong  (sample 4)                           |
  |  ── ping ─►  ... ◄── pong  (sample 5)                           |
  |                                                                 |
  |  drop samples with rtt > median(rtt) + stdDev(rtt)              |
  |  net.clockOffsetMs = mean(filtered.offsets)                     |
  |  net.smoothedRttMs = mean(filtered.rtts)                        |
  |                                                                 |
  |  start 1 Hz maintenance ping…                                   |
```

## Edge cases

- **Tab put to sleep, comes back.** `performance.now()` keeps ticking but the socket may have heartbeat-died and been resurrected. Maintenance ping after wake will detect a huge `driftMs` (because the EMA was integrated against a stale offset) and trigger an `runInitialSync` re-sync. The world will rubber-band remote planes for ~1 s while the offset re-settles — acceptable for v1.
- **Pong dropped or socket disconnects mid-sync.** `pingOnce` returns `null` after a 1500 ms timeout. The sample is skipped. Initial sync runs with whatever `≥0` samples it gathered. If `0`, offset stays at the default (`0`) — this means until the first successful maintenance pong, `serverTimeNow()` returns plain `performance.now()`, and the first interp-buffer reads will be wonky. We accept this; v2 can stall the simulation start until at least 1 sample lands.
- **Server clock backwards (e.g. dev restart).** Maintenance EMA drifts the offset toward the new value; `driftMs > 80` will probably fire and re-sync.
- **Player joins, never gets initial sync to land** (e.g. all 5 pings drop). Snapshots still arrive; the interpolation code falls back to "use last snapshot's `serverTime` as the reference" (mirrors Garama's `estimateServerNowMs` fallback in [`interpolateRemotePlayers.ts`](../../../Garama/frontend/src/game/net/interpolateRemotePlayers.ts:11)). World plays, just less accurately.

## What lives where

```
backend/src/net/socketHandlers.ts       on('ping') ─► emit('pong', {…clientSendTimeMs, serverTimeMs, serverTick})
backend/src/utils/clock.ts              monotonic getServerTimeMs() helper

frontend/src/net/clock.ts               startClockSync(socket, net) → { stop }
                                        serverTimeNow(net) helper
frontend/src/net/netSystem.ts           owns NetState + wires the socket
```

## Tunables (recap)

```ts
NET.CLOCK_SYNC_INITIAL_SAMPLES    = 5;
NET.CLOCK_SYNC_PAUSE_MS           = 200;
NET.CLOCK_SYNC_MAINTENANCE_MS     = 1000;
NET.CLOCK_SYNC_EMA_ALPHA          = 0.12;
NET.CLOCK_SYNC_DRIFT_RESYNC_MS    = 80;
NET.CLOCK_SYNC_RTT_SPIKE_MS       = 180;
```

## Future work (post-v1)

- Adaptive `INTERP_DELAY_MS` based on `smoothedRttMs` and packet-loss estimate (Garama already does this at lines 52–55 of `clockSync.ts`).
- Continuous offset drift correction with **sub-millisecond** ramping rather than instant EMA write (visible smoothing of the interpolation timeline).
- Per-snapshot `serverTimeMs` is already free RTT data — feed it into the maintenance EMA at high frequency.
