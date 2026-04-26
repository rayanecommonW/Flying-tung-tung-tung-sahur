/**
 * Clock synchronization with the server.
 *
 * Direct port of Garama's `frontend/src/game/net/clockSync.ts` with v1
 * adaptations from `plans/networking/02_CLOCK_SYNC.md`:
 *  - K = 5 initial samples (Garama uses 8)
 *  - 200 ms pause between samples
 *  - 1500 ms per-ping timeout
 *  - 1 Hz maintenance ping forever
 *  - EMA α = 0.12 for offset/RTT smoothing
 *  - Drift > 80 ms or RTT spike > 180 ms → re-run initial sync
 */

import { NET } from '@flying-tung-tung/shared';
import type { TypedSocket } from './socket';
import type { NetState } from './netState';

interface Sample {
  rttMs: number;
  offsetMs: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / values.length);
}

function dropOutliers(samples: Sample[]): Sample[] {
  if (samples.length <= 2) return samples;
  const rtts = samples.map((s) => s.rttMs);
  const cutoff = median(rtts) + stdDev(rtts);
  return samples.filter((s) => s.rttMs <= cutoff);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ClockSyncHandle {
  stop(): void;
}

/**
 * Start the clock-sync system. Mutates `net.clockOffsetMs` + `net.smoothedRttMs`
 * as samples land. Returns a `stop()` to halt the maintenance loop on
 * disconnect.
 */
export function startClockSync(socket: TypedSocket, net: NetState): ClockSyncHandle {
  let stopped = false;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let resyncing = false;

  // Outstanding ping awaiting its pong reply.
  let pending:
    | {
        sentAt: number;
        timeoutId: ReturnType<typeof setTimeout>;
        resolve: (sample: Sample | null) => void;
      }
    | null = null;

  const handlePong = (msg: { clientSendTimeMs: number; serverTimeMs: number }): void => {
    if (!pending) return;
    const recvAt = performance.now();
    clearTimeout(pending.timeoutId);
    const rttMs = recvAt - pending.sentAt;
    const estServerNow = msg.serverTimeMs + rttMs / 2;
    const offsetMs = estServerNow - recvAt;
    const r = pending.resolve;
    pending = null;
    r({ rttMs, offsetMs });
  };

  socket.onPong(handlePong);

  const pingOnce = (): Promise<Sample | null> =>
    new Promise((resolve) => {
      if (stopped || pending) {
        resolve(null);
        return;
      }
      const sentAt = performance.now();
      const timeoutId = setTimeout(() => {
        pending = null;
        resolve(null);
      }, NET.CLOCK_SYNC_PING_TIMEOUT_MS);
      pending = { sentAt, timeoutId, resolve };
      socket.emitPing({ clientSendTimeMs: sentAt });
    });

  const runInitialSync = async (): Promise<void> => {
    const samples: Sample[] = [];
    for (let i = 0; i < NET.CLOCK_SYNC_INITIAL_SAMPLES && !stopped; i++) {
      const s = await pingOnce();
      if (s) samples.push(s);
      await sleep(NET.CLOCK_SYNC_PAUSE_MS);
    }
    const filtered = dropOutliers(samples);
    if (filtered.length === 0) return;
    net.clockOffsetMs = mean(filtered.map((s) => s.offsetMs));
    net.smoothedRttMs = mean(filtered.map((s) => s.rttMs));
    console.info(
      `[clock] initial sync: rtt=${net.smoothedRttMs.toFixed(1)}ms offset=${net.clockOffsetMs.toFixed(1)}ms (samples=${filtered.length}/${samples.length})`
    );
  };

  const runMaintenanceTick = async (): Promise<void> => {
    const sample = await pingOnce();
    if (!sample || stopped) return;

    const prevOffset = net.clockOffsetMs;
    const prevRtt = net.smoothedRttMs;

    if (!prevRtt) {
      net.clockOffsetMs = sample.offsetMs;
      net.smoothedRttMs = sample.rttMs;
      return;
    }

    const driftMs = Math.abs(sample.offsetMs - prevOffset);
    const rttSpikeMs = sample.rttMs - prevRtt;

    const a = NET.CLOCK_SYNC_EMA_ALPHA;
    net.clockOffsetMs = a * sample.offsetMs + (1 - a) * prevOffset;
    net.smoothedRttMs = a * sample.rttMs + (1 - a) * prevRtt;

    if (resyncing) return;
    if (
      driftMs > NET.CLOCK_SYNC_DRIFT_RESYNC_MS ||
      rttSpikeMs > NET.CLOCK_SYNC_RTT_SPIKE_MS
    ) {
      console.info(
        `[clock] drift=${driftMs.toFixed(1)}ms rttSpike=${rttSpikeMs.toFixed(1)}ms → re-sync`
      );
      resyncing = true;
      await runInitialSync();
      resyncing = false;
    }
  };

  // Boot the loop.
  void (async () => {
    await runInitialSync();
    if (stopped) return;
    maintenanceTimer = setInterval(() => {
      void runMaintenanceTick();
    }, NET.CLOCK_SYNC_MAINTENANCE_MS);
  })();

  return {
    stop(): void {
      stopped = true;
      if (maintenanceTimer !== null) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
      }
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.resolve(null);
        pending = null;
      }
    },
  };
}
