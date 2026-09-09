/**
 * Replay timeline: absolute offsets per pool index, VU partitioning and
 * automatic VU sizing. Every request fires at `start + offset / ratio`, so
 * inter-request gaps are exactly the log's gaps divided by RATIO. Pure.
 */

/** Requests logged in the same instant are spread over at most this window (1s log granularity). */
export const SPREAD_WINDOW_MS = 1000;

/**
 * Offsets (ms from the first request) for sorted timestamps.
 * Entries that share a timestamp are spread evenly over the gap to the next
 * distinct timestamp, capped at SPREAD_WINDOW_MS.
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

/**
 * Highest number of requests due within any wall-clock window of `windowMs`
 * (sliding over the compressed timeline). Peak rps = result / (windowMs/1000).
 */
export function peakRps(offsets: readonly number[], ratio: number, windowMs = 1000): number {
  if (offsets.length === 0) return 0;
  let best = 0;
  let head = 0;
  for (let tail = 0; tail < offsets.length; tail += 1) {
    const tailAt = (offsets[tail] ?? 0) / ratio;
    while (head < tail && (offsets[head] ?? 0) / ratio <= tailAt - windowMs) head += 1;
    best = Math.max(best, tail - head + 1);
  }
  return best / (windowMs / 1000);
}

export interface VuAllocation {
  readonly preAllocatedVUs: number;
  readonly maxVUs: number;
  readonly auto: boolean;
  /** Latency (ms) the automatic sizing assumed. */
  readonly assumedLatencyMs: number;
}

/** Floor for the assumed round trip when sizing VUs automatically. */
export const MIN_ASSUMED_LATENCY_MS = 250;
const AUTO_HEADROOM = 2;
const MIN_AUTO_VUS = 10;
const MAX_AUTO_VUS = 2000;

/**
 * VUs needed to keep up with `peakRps`: peak × latency × headroom. Explicit
 * values win. `measuredLatencyMs` (e.g. from discover probes) raises the
 * assumed latency above the floor.
 */
export function allocateVus(
  peak: number,
  vus: number | null,
  maxVus: number | null,
  measuredLatencyMs: number | null = null,
): VuAllocation {
  const assumedLatencyMs = Math.max(MIN_ASSUMED_LATENCY_MS, measuredLatencyMs ?? 0);
  const needed = Math.ceil((peak * assumedLatencyMs * AUTO_HEADROOM) / 1000);
  const pre = vus ?? Math.min(MAX_AUTO_VUS, Math.max(MIN_AUTO_VUS, needed));
  const max = maxVus ?? Math.min(5000, Math.max(200, pre * 4));
  return { preAllocatedVUs: pre, maxVUs: Math.max(pre, max), auto: vus === null, assumedLatencyMs };
}
