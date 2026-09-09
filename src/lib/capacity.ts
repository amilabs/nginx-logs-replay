/**
 * Latency by offered load: every replayed request is tagged with the rate it
 * was fired at (requests due in the trailing wall-clock second), bucketed so
 * that k6 can expose per-bucket sub-metrics. From those buckets the report
 * finds the load at which latency starts to degrade and converts it into a
 * RATIO for the next run. Pure.
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

const MIN_SAMPLES = 20;
/** The reference p95 may not exceed this multiple of the discover probe latency. */
const PROBE_REFERENCE_FACTOR = 3;
const DEGRADATION_FACTOR = 2;
const DEGRADATION_SLACK_MS = 50;
const FAIL_LIMIT = 0.01;

/** A bucket is degraded when its p95 doubles the reference (plus slack) or it fails. */
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
  const populated = sorted.filter((r) => r.count >= MIN_SAMPLES);
  const candidates = populated.length > 0 ? populated : sorted;
  if (candidates.length === 0) return { rows: sorted, referenceP95: null, healthyUpToRps: null, degradedFromRps: null };
  const bestP95 = Math.min(...candidates.map((r) => r.duration.p95));
  const referenceP95 = probeAvgMs !== null && probeAvgMs > 0 ? Math.min(bestP95, probeAvgMs * PROBE_REFERENCE_FACTOR) : bestP95;
  let healthy: number | null = null;
  let degradedFrom: number | null = null;
  for (const row of sorted) {
    if (row.count < MIN_SAMPLES && populated.length > 0) continue;
    if (isDegraded(row, referenceP95)) {
      degradedFrom = row.upToRps;
      break;
    }
    healthy = row.upToRps;
  }
  return { rows: sorted, referenceP95, healthyUpToRps: healthy, degradedFromRps: degradedFrom };
}

export interface Recommendation {
  readonly verdict: string;
  /** True when the whole run was over the limit (timeline lag / drops), so the knee is only a lower bound. */
  readonly saturated: boolean;
  /** RATIO to run next (replay), rounded to one decimal. */
  readonly nextRatio: number | null;
  /** Highest RATIO with no degradation observed in this run, if a knee was found. */
  readonly safeRatio: number | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Rate mode: one bucket; compare with the discover probe (or the run's own p50 when unknown). */
export function recommendRps(row: LoadRow | undefined, rps: number, probeAvgMs: number | null): Recommendation {
  if (!row || row.count === 0) return { verdict: 'Not enough data to judge this rate.', nextRatio: null, safeRatio: null, saturated: false };
  const reference = probeAvgMs !== null && probeAvgMs > 0 ? probeAvgMs : row.duration.p50;
  const degraded = isDegraded(row, reference);
  const ref = Math.round(reference);
  if (degraded) {
    const next = Math.max(1, Math.round(rps * 0.7));
    return {
      verdict: `Degraded at ${rps} rps: p95 ${Math.round(row.duration.p95)}ms vs ${ref}ms baseline${row.failedRate > FAIL_LIMIT ? `, ${(row.failedRate * 100).toFixed(1)}% failed` : ''}. Try RPS=${next}.`,
      nextRatio: null,
      safeRatio: null,
      saturated: true,
    };
  }
  const next = Math.round(rps * 1.5);
  return {
    verdict: `No degradation at ${rps} rps (p95 ${Math.round(row.duration.p95)}ms vs ${ref}ms baseline). Try RPS=${next} to look for the limit.`,
    nextRatio: null,
    safeRatio: null,
    saturated: false,
  };
}

/**
 * Turns the knee into advice for the next replay. `originalPeakRps` is the
 * busiest second of the log at ratio 1; `ratio` is this run's ratio;
 * `saturated` says the run as a whole was over the limit (timeline lag or
 * dropped requests), in which case quiet seconds still carry backlog and the
 * knee is only a lower bound, so the next step is a plain cut.
 */
export function recommendRatio(analysis: CapacityAnalysis, ratio: number, originalPeakRps: number, saturated = false): Recommendation {
  if (analysis.referenceP95 === null || analysis.rows.length === 0 || originalPeakRps <= 0) {
    return { verdict: 'Not enough data to locate the degradation point.', nextRatio: null, safeRatio: null, saturated };
  }
  const ref = Math.round(analysis.referenceP95);
  if (analysis.degradedFromRps === null) {
    const next = round1(ratio * 1.5);
    return {
      verdict: `No degradation up to the busiest second of this run (p95 stayed within 2× the ${ref}ms reference). Try RATIO=${next} to look for the limit.`,
      nextRatio: next,
      safeRatio: ratio,
      saturated,
    };
  }
  if (analysis.healthyUpToRps === null) {
    const next = round1(Math.max(0.1, ratio / 2));
    return {
      verdict: `Latency was degraded even at the lowest load of this run (from ${analysis.degradedFromRps} rps, p95 > 2× the ${ref}ms reference). Try RATIO=${next}.`,
      nextRatio: next,
      safeRatio: null,
      saturated,
    };
  }
  const safe = round1(Math.max(0.1, analysis.healthyUpToRps / originalPeakRps));
  const knee = `Healthy up to ~${analysis.healthyUpToRps} rps, degraded from ~${analysis.degradedFromRps} rps (p95 > 2× the ${ref}ms reference). The log peaks at ${round1(originalPeakRps)} rps, so that is RATIO x${safe}.`;
  if (saturated) {
    const next = round1(Math.max(safe, ratio * 0.6));
    return {
      verdict: `${knee} This run was over the limit as a whole (requests fired late or were dropped), so quiet seconds still carried backlog and x${safe} is a lower bound. Next run: RATIO=${next}.`,
      nextRatio: next,
      safeRatio: safe,
      saturated,
    };
  }
  return {
    verdict: `${knee} Next run: RATIO=${safe} to confirm.`,
    nextRatio: safe,
    safeRatio: safe,
    saturated,
  };
}
