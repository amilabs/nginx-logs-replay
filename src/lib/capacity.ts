/**
 * Latency by offered load: every replayed request is tagged with the rate it
 * was fired at (requests due in the trailing wall-clock second), bucketed so
 * that k6 can expose per-bucket sub-metrics. From those buckets the report
 * finds the load at which latency starts to degrade and converts it into a
 * RATIO for the next run. Pure.
 */

import { fmtDuration, fmtMs } from './format.ts';
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

export interface Recommendation {
  readonly verdict: string;
  /** RATIO to run next (replay), rounded to one decimal. */
  readonly nextRatio: number | null;
  /** RATIO at which latency starts climbing (informational), if a knee was found. */
  readonly kneeRatio: number | null;
  /** True when the target capped the run (it overran its plan or dropped requests). */
  readonly capped: boolean;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Rate mode: one bucket; compare with the discover probe (or the run's own p50 when unknown). */
export function recommendRps(row: LoadRow | undefined, rps: number, probeAvgMs: number | null): Recommendation {
  if (!row || row.count === 0) return { verdict: 'Not enough data to judge this rate.', nextRatio: null, kneeRatio: null, capped: false };
  const reference = probeAvgMs !== null && probeAvgMs > 0 ? probeAvgMs : row.duration.p50;
  const degraded = isDegraded(row, reference);
  const ref = Math.round(reference);
  if (degraded) {
    const next = Math.max(1, Math.round(rps * 0.7));
    return {
      verdict: `Degraded at ${rps} rps: p95 ${Math.round(row.duration.p95)}ms vs ${ref}ms baseline${row.failedRate > FAIL_LIMIT ? `, ${(row.failedRate * 100).toFixed(1)}% failed` : ''}. Try RPS=${next}.`,
      nextRatio: null,
      kneeRatio: null,
      capped: true,
    };
  }
  const next = Math.round(rps * 1.5);
  return {
    verdict: `No degradation at ${rps} rps (p95 ${Math.round(row.duration.p95)}ms vs ${ref}ms baseline). Try RPS=${next} to look for the limit.`,
    nextRatio: null,
    kneeRatio: null,
    capped: false,
  };
}

export interface FastestInput {
  readonly ratio: number;
  /** Average rps of the log at ratio 1. */
  readonly originalAvgRps: number;
  /** Busiest second of the log at ratio 1. */
  readonly originalPeakRps: number;
  readonly achievedRps: number;
  readonly plannedMs: number | null;
  readonly durationMs: number;
  readonly lagP50: number | null;
  readonly dropped: number;
  readonly knee: CapacityAnalysis;
}

/** A run is capped when it overran its plan by more than this share. */
const OVERRUN_SHARE = 0.1;
/** ...and by at least this much, so setup/teardown overhead on tiny runs does not count. */
const OVERRUN_MIN_MS = 5000;
const CAP_MARGIN = 0.95;

function kneeNote(knee: CapacityAnalysis, originalPeakRps: number): { text: string; kneeRatio: number | null } {
  if (knee.healthyUpToRps !== null && knee.degradedFromRps !== null && originalPeakRps > 0) {
    const kneeRatio = round1(Math.max(0.1, knee.healthyUpToRps / originalPeakRps));
    return {
      kneeRatio,
      text: ` Latency starts climbing around ~${knee.degradedFromRps} rps (~x${kneeRatio}): past that requests get slower, but the full replay still finishes sooner until the throughput cap.`,
    };
  }
  if (knee.rows.length > 0 && knee.degradedFromRps === null) return { kneeRatio: null, text: ' Latency stayed flat across all load levels of this run.' };
  return { kneeRatio: null, text: '' };
}

/**
 * Fastest-full-replay criterion: raise RATIO while the run still finishes on
 * schedule; once the target caps, the run overruns its plan and the achieved
 * rps stops growing. The best RATIO is then cap ÷ average log rps.
 */
export function recommendFastest(input: FastestInput): Recommendation {
  const { ratio, originalAvgRps, achievedRps, plannedMs, durationMs, dropped } = input;
  const note = kneeNote(input.knee, input.originalPeakRps);
  if (plannedMs === null || plannedMs <= 0 || durationMs <= 0 || originalAvgRps <= 0) {
    return { verdict: `Not enough data to judge the run time.${note.text}`, nextRatio: null, kneeRatio: note.kneeRatio, capped: false };
  }
  const overrunMs = durationMs - plannedMs;
  const lagP50 = input.lagP50 ?? 0;
  if ((overrunMs > OVERRUN_MIN_MS && overrunMs / plannedMs > OVERRUN_SHARE) || dropped > 0) {
    let best = round1(Math.max(0.1, (achievedRps / originalAvgRps) * CAP_MARGIN));
    if (best >= ratio) best = round1(Math.max(0.1, ratio * 0.8));
    const drops = dropped > 0 ? ` and ${dropped} requests were never sent` : '';
    return {
      verdict: `At x${ratio} the target capped at ~${round1(achievedRps)} rps: the full replay took ${fmtDuration(durationMs)}, ${fmtDuration(Math.max(0, overrunMs))} longer than the planned ${fmtDuration(plannedMs)}${drops}. Fastest full replay ≈ RATIO x${best} (${round1(achievedRps)} rps ÷ ${round1(originalAvgRps)} rps average of the log, minus 5%). Suggested next run: RATIO=${best}.${note.text}`,
      nextRatio: best,
      kneeRatio: note.kneeRatio,
      capped: true,
    };
  }
  if (lagP50 > 1000) {
    const next = round1(ratio * 1.2);
    return {
      verdict: `On schedule at x${ratio} (${fmtDuration(durationMs)} vs planned ${fmtDuration(plannedMs)}) but requests already queue during bursts (median lag ${fmtMs(lagP50)}): the throughput cap is close. Suggested next run: RATIO=${next} (×1.2).${note.text}`,
      nextRatio: next,
      kneeRatio: note.kneeRatio,
      capped: false,
    };
  }
  const next = round1(ratio * 1.5);
  return {
    verdict: `On schedule at x${ratio}: the full replay took ${fmtDuration(durationMs)} vs planned ${fmtDuration(plannedMs)} and the target kept up (median lag ${fmtMs(lagP50)}). Suggested next run: RATIO=${next} (×1.5) to look for the throughput cap.${note.text}`,
    nextRatio: next,
    kneeRatio: note.kneeRatio,
    capped: false,
  };
}
