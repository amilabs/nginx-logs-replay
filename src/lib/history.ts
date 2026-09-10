/**
 * Run history: one record per replay of the same log against the same
 * target, kept in a small JSON file (HISTORY) so that the next run can search
 * for the fastest RATIO by bisection instead of guessing from one run. Pure.
 */

import { fmtDuration, fmtNum } from './format.ts';

export interface HistoryRun {
  /** Groups runs of the same log / target / query setup. */
  readonly key: string;
  readonly at: string;
  readonly ratio: number;
  readonly plannedMs: number;
  readonly durationMs: number;
  readonly achievedRps: number;
  readonly requests: number;
  readonly failed: number;
  readonly lagP50Ms: number;
  readonly p95Ms: number;
  readonly label?: string;
}

export const HISTORY_LIMIT = 100;
/** A run counts as capped when it overran its plan by more than this share (and by more than OVERRUN_MIN_MS). */
export const OVERRUN_SHARE = 0.1;
export const OVERRUN_MIN_MS = 5000;
/** Bisection stops when the capped ratio is within this factor of the best on-schedule ratio. */
export const CONVERGED_FACTOR = 1.15;

export interface HistoryKeyInput {
  readonly prefix: string;
  readonly mode: string;
  readonly poolKept: number;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly queryParams: readonly (readonly [string, string])[];
  readonly skipStatuses: readonly string[];
  readonly filterOnly: readonly string[];
  readonly filterSkip: readonly string[];
}

/** Stable identity of "this log replayed against this target with these options". */
export function historyKey(input: HistoryKeyInput): string {
  const query = input.queryParams.map(([k, v]) => `${k}=${v}`).join('&');
  return [
    input.mode,
    input.prefix,
    `${input.poolKept}@${input.firstTs}-${input.lastTs}`,
    query,
    input.skipStatuses.join(','),
    input.filterOnly.join(','),
    input.filterSkip.join(','),
  ].join('|');
}

function isRun(value: unknown): value is HistoryRun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === 'string' &&
    typeof v.ratio === 'number' &&
    typeof v.plannedMs === 'number' &&
    typeof v.durationMs === 'number' &&
    typeof v.achievedRps === 'number'
  );
}

/** Parses the history file content; anything malformed yields an empty history. */
export function parseHistory(text: string | null | undefined): HistoryRun[] {
  if (!text) return [];
  try {
    const raw: unknown = JSON.parse(text);
    return Array.isArray(raw) ? raw.filter(isRun) : [];
  } catch {
    return [];
  }
}

/** Appends a run and keeps the file bounded. */
export function appendHistory(history: readonly HistoryRun[], run: HistoryRun): HistoryRun[] {
  return [...history, run].slice(-HISTORY_LIMIT);
}

export function isCapped(run: Pick<HistoryRun, 'plannedMs' | 'durationMs'>): boolean {
  const overrun = run.durationMs - run.plannedMs;
  return run.plannedMs > 0 && overrun > OVERRUN_MIN_MS && overrun / run.plannedMs > OVERRUN_SHARE;
}

export interface HistoryRecommendation {
  readonly verdict: string;
  readonly nextRatio: number | null;
  /** Fastest on-schedule ratio seen so far. */
  readonly bestRatio: number | null;
  /** Lowest ratio that overran its plan above bestRatio. */
  readonly cappedRatio: number | null;
  readonly converged: boolean;
  /** Same-key runs, ascending by ratio, deduplicated to the latest per ratio. */
  readonly series: readonly HistoryRun[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Latest run per ratio for the given key, ascending by ratio. */
export function seriesFor(history: readonly HistoryRun[], key: string): HistoryRun[] {
  const latest = new Map<number, HistoryRun>();
  for (const run of history) if (run.key === key) latest.set(run.ratio, run);
  return [...latest.values()].sort((a, b) => a.ratio - b.ratio);
}

/**
 * Bisection over the history: the fastest on-schedule ratio is the lower
 * bound, the lowest capped ratio above it the upper bound. Throughput under
 * overload is NOT a capacity estimate (queues and timeouts pull it down), so
 * the next step is always between the bounds or a multiplicative probe.
 */
export function recommendFromHistory(history: readonly HistoryRun[], key: string): HistoryRecommendation {
  const series = seriesFor(history, key);
  if (series.length === 0) {
    return { verdict: 'No earlier runs of this log against this target yet.', nextRatio: null, bestRatio: null, cappedRatio: null, converged: false, series };
  }
  const onSchedule = series.filter((r) => !isCapped(r));
  const best = onSchedule.reduce<HistoryRun | null>((acc, r) => (acc === null || r.durationMs < acc.durationMs ? r : acc), null);
  const cappedAbove = series.filter((r) => isCapped(r) && (best === null || r.ratio > best.ratio));
  const capped = cappedAbove.reduce<HistoryRun | null>((acc, r) => (acc === null || r.ratio < acc.ratio ? r : acc), null);
  const table = series
    .map((r) => `x${r.ratio}: ${fmtDuration(r.durationMs)}${isCapped(r) ? ' (overran)' : ''}`)
    .join(', ');

  if (best === null) {
    const lowest = series[0];
    const next = round1(Math.max(0.1, (lowest?.ratio ?? 1) / 2));
    return {
      verdict: `Every run so far overran its plan (${table}). Suggested next run: RATIO=${next}.`,
      nextRatio: next,
      bestRatio: null,
      cappedRatio: lowest?.ratio ?? null,
      converged: false,
      series,
    };
  }
  if (capped === null) {
    const next = round1(best.ratio * 1.5);
    return {
      verdict: `Fastest full replay so far: x${best.ratio} in ${fmtDuration(best.durationMs)} (${fmtNum(best.achievedRps, 1)} rps), no run has overrun yet (${table}). Suggested next run: RATIO=${next} (×1.5).`,
      nextRatio: next,
      bestRatio: best.ratio,
      cappedRatio: null,
      converged: false,
      series,
    };
  }
  if (capped.ratio / best.ratio <= CONVERGED_FACTOR) {
    return {
      verdict: `Optimum found: x${best.ratio} replays the whole log fastest (${fmtDuration(best.durationMs)}, ${fmtNum(best.achievedRps, 1)} rps); x${capped.ratio} already overruns (${fmtDuration(capped.durationMs)}). History: ${table}. Suggested next run: RATIO=${best.ratio} (re-run to confirm, or stop here).`,
      nextRatio: best.ratio,
      bestRatio: best.ratio,
      cappedRatio: capped.ratio,
      converged: true,
      series,
    };
  }
  const next = round1(Math.sqrt(best.ratio * capped.ratio));
  return {
    verdict: `Fastest full replay so far: x${best.ratio} in ${fmtDuration(best.durationMs)} (${fmtNum(best.achievedRps, 1)} rps); x${capped.ratio} overruns (${fmtDuration(capped.durationMs)}, ${fmtNum(capped.achievedRps, 1)} rps: throughput under overload is lower, not the capacity). History: ${table}. Suggested next run: RATIO=${next} (between the two).`,
    nextRatio: next,
    bestRatio: best.ratio,
    cappedRatio: capped.ratio,
    converged: false,
    series,
  };
}
