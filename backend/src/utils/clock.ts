/**
 * Monotonic server clock. Wall-clock-immune; used as the canonical
 * `serverTimeMs` on every snapshot, pong, and per-player heartbeat check.
 *
 * `process.hrtime.bigint()` returns nanoseconds since some arbitrary base.
 * We snapshot the base at module load and convert to ms on demand, never
 * calling `Date.now()` inside the sim path.
 */

const startNs = process.hrtime.bigint();

export function getServerTimeMs(): number {
  return Number((process.hrtime.bigint() - startNs) / 1_000_000n);
}
