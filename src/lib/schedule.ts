/**
 * Replay timeline: absolute offsets per pool index and VU partitioning.
 * Pure. Absolute scheduling (start + offset / ratio) means no cumulative drift.
 */

/** Requests logged in the same instant are spread over at most this window. */
export const SPREAD_WINDOW_MS = 1000;

/**
 * Offsets (ms from the first request) for sorted timestamps.
 * Entries that share a timestamp (1s log granularity) are spread evenly over
 * the gap to the next distinct timestamp, capped at SPREAD_WINDOW_MS.
 */
export function buildOffsets(timestamps: readonly number[]): number[] {
  const first = timestamps[0];
  if (first === undefined) return [];
  const offsets: number[] = new Array(timestamps.length);
  let bucketStart = 0;
  while (bucketStart < timestamps.length) {
    const ts = timestamps[bucketStart] ?? first;
    let bucketEnd = bucketStart;
    while (bucketEnd < timestamps.length && timestamps[bucketEnd] === ts) bucketEnd += 1;
    const next = timestamps[bucketEnd];
    const window = next === undefined ? SPREAD_WINDOW_MS : Math.min(SPREAD_WINDOW_MS, next - ts);
    const count = bucketEnd - bucketStart;
    for (let k = 0; k < count; k += 1) {
      offsets[bucketStart + k] = ts - first + (window * k) / count;
    }
    bucketStart = bucketEnd;
  }
  return offsets;
}

/** Pool index handled by VU `vuId` (1-based) at its `iteration` (0-based). */
export function poolIndex(vuId: number, iteration: number, vus: number): number {
  return iteration * vus + (vuId - 1);
}

/** Iterations each VU needs so that all `n` entries are covered. */
export function iterationsPerVu(n: number, vus: number): number {
  return Math.ceil(n / vus);
}

/** Wall-clock time (ms) at which the request with `offsetMs` should fire. */
export function targetTime(startMs: number, offsetMs: number, ratio: number): number {
  return startMs + offsetMs / ratio;
}

/** Wall-clock span of the whole replay at the given ratio. */
export function replaySpanMs(offsets: readonly number[], ratio: number): number {
  const last = offsets[offsets.length - 1];
  return last === undefined ? 0 : last / ratio;
}

/** k6 duration string with a safety margin for the replay scenario. */
export function replayMaxDuration(offsets: readonly number[], ratio: number, timeoutMs: number, marginMs = 30_000): string {
  const total = replaySpanMs(offsets, ratio) + timeoutMs + marginMs;
  return `${Math.ceil(total / 1000)}s`;
}
