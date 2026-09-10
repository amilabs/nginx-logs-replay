/**
 * Latency by offered load: every replayed request is tagged with the rate it
 * was fired at (requests due in the trailing wall-clock second), bucketed so
 * that k6 can expose per-bucket sub-metrics. The report shows latency per
 * bucket and where it starts to climb. Informational only. Pure.
 */

import type { Percentiles } from './summary.ts';

export const LOAD_BUCKETS = 8;

/** Offered rate (requests per second) at the moment each request is due, on the compressed timeline. */
export function offeredRps(offsets: readonly number[], ratio: number, windowMs = 1000): number[] {
  const out: number[] = new Array(offsets.length);
  let head = 0;
  for (let tail = 0; tail < offsets.length; tail += 1) {
    const tailAt = (offsets[tail] ?? 0) / ratio;
    while (head < tail && (offsets[head] ?? 0) / ratio <= tailAt - windowMs) head += 1;
    out[tail] = (tail - head + 1) / (windowMs / 1000);
  }
  return out;
}

/** Upper edges of `count` equal-width load buckets up to `peak` (integers, strictly increasing). */
export function loadEdges(peak: number, count = LOAD_BUCKETS): number[] {
  if (peak <= 0) return [];
  const edges: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    const edge = Math.ceil((peak * i) / count);
    if (edge > (edges[edges.length - 1] ?? 0)) edges.push(edge);
  }
  return edges;
}

/** Tag value (upper edge) for an offered rate. */
export function loadTag(rps: number, edges: readonly number[]): string {
  for (const edge of edges) if (rps <= edge) return String(edge);
  return String(edges[edges.length - 1] ?? 0);
}

export interface LoadRow {
  /** Bucket upper edge, requests per second. */
  readonly upToRps: number;
  readonly count: number;
  readonly failedRate: number;
  readonly duration: Percentiles;
}

export interface CapacityAnalysis {
  readonly rows: readonly LoadRow[];
  /** p95 at the lowest well-populated bucket (ms). */
  readonly referenceP95: number | null;
  /** Highest offered rate with no degradation (upper edge of the last healthy bucket). */
  readonly healthyUpToRps: number | null;
  /** First bucket (upper edge) where latency degraded, or null when none did. */
  readonly degradedFromRps: number | null;
}

/** A bucket takes part in the analysis only with at least this many requests and 2% of the run. */
const MIN_SAMPLES_ABS = 100;
const MIN_SAMPLES_SHARE = 0.02;

export function minSamples(totalRequests: number): number {
  return Math.max(MIN_SAMPLES_ABS, Math.round(totalRequests * MIN_SAMPLES_SHARE));
}
/** The reference p95 may not exceed this multiple of the discover probe latency. */
const PROBE_REFERENCE_FACTOR = 3;
const DEGRADATION_FACTOR = 2;
const DEGRADATION_SLACK_MS = 200;
const FAIL_LIMIT = 0.01;

/** A bucket is degraded when its p95 exceeds twice the reference plus 200ms, or more than 1% of it fails. */
export function isDegraded(row: LoadRow, referenceP95: number): boolean {
  return row.failedRate > FAIL_LIMIT || row.duration.p95 > referenceP95 * DEGRADATION_FACTOR + DEGRADATION_SLACK_MS;
}

/**
 * Finds the knee in latency-by-load rows (ascending by upToRps). The
 * reference is the best p95 among populated buckets, capped at 3× the
 * discover probe latency so a run that is saturated throughout (backlog even
 * in its quiet seconds) does not set a slow "baseline".
 */
export function analyzeCapacity(rows: readonly LoadRow[], probeAvgMs: number | null = null): CapacityAnalysis {
  const sorted = [...rows].sort((a, b) => a.upToRps - b.upToRps);
  const threshold = minSamples(sorted.reduce((sum, r) => sum + r.count, 0));
  const populated = sorted.filter((r) => r.count >= threshold);
  const candidates = populated.length > 0 ? populated : sorted;
  if (candidates.length === 0) return { rows: sorted, referenceP95: null, healthyUpToRps: null, degradedFromRps: null };
  const bestP95 = Math.min(...candidates.map((r) => r.duration.p95));
  const referenceP95 = probeAvgMs !== null && probeAvgMs > 0 ? Math.min(bestP95, probeAvgMs * PROBE_REFERENCE_FACTOR) : bestP95;
  let healthy: number | null = null;
  let degradedFrom: number | null = null;
  for (const row of sorted) {
    if (row.count < threshold && populated.length > 0) continue;
    if (isDegraded(row, referenceP95)) {
      degradedFrom = row.upToRps;
      break;
    }
    healthy = row.upToRps;
  }
  return { rows: sorted, referenceP95, healthyUpToRps: healthy, degradedFromRps: degradedFrom };
}

/** One informational sentence about the latency-by-load table (no advice). */
export function capacityNote(analysis: CapacityAnalysis): string {
  if (analysis.referenceP95 === null || analysis.rows.length === 0) return 'Not enough data to see how latency depends on load.';
  const ref = Math.round(analysis.referenceP95);
  if (analysis.degradedFromRps === null) return `Latency stayed flat across all load levels of this run (p95 within 2× the ${ref}ms reference).`;
  if (analysis.healthyUpToRps === null) return `Latency was already elevated at the lowest well-populated load (≤ ${analysis.degradedFromRps} rps, p95 > 2× the ${ref}ms reference).`;
  return `Latency stays flat up to ~${analysis.healthyUpToRps} rps and starts to climb around ~${analysis.degradedFromRps} rps (p95 > 2× the ${ref}ms reference).`;
}
