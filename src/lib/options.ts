/**
 * Builds the k6 `options` object for replay/rate modes.
 * Pure: returns a plain object; replay.ts casts it to k6's Options type.
 */

import type { Config } from './config.ts';
import { allocateVus, buildOffsets, iterationsPerVu, peakRps, replayMaxDuration, replaySpanMs, type VuAllocation } from './schedule.ts';

export const SCENARIO_NAME = 'nginx_replay';
export const TREND_STATS = ['avg', 'min', 'med', 'p(75)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'] as const;

export interface EndpointCount {
  readonly endpoint: string;
  readonly count: number;
}

export type Thresholds = Readonly<Record<string, readonly string[]>>;

/** Tag values that are safe inside a threshold sub-metric selector. */
const SAFE_TAG_RE = /^[A-Za-z0-9_\-./%~+@:]+$/;

/**
 * Always-passing thresholds per endpoint so that k6 exposes per-endpoint
 * sub-metrics in handleSummary.
 */
export function buildThresholds(endpoints: readonly EndpointCount[]): Thresholds {
  const entries: [string, readonly string[]][] = [];
  for (const { endpoint } of endpoints) {
    if (!SAFE_TAG_RE.test(endpoint)) continue;
    entries.push([`http_reqs{endpoint:${endpoint}}`, ['count>=0']]);
    entries.push([`http_req_duration{endpoint:${endpoint}}`, ['max>=0']]);
    entries.push([`http_req_failed{endpoint:${endpoint}}`, ['rate>=0']]);
    entries.push([`replay_status_mismatch{endpoint:${endpoint}}`, ['count>=0']]);
  }
  return Object.fromEntries(entries);
}

export interface LoadPlan {
  readonly scenario: Record<string, unknown>;
  readonly vus: VuAllocation;
  /** VUs the replay scenario actually runs with (capped at the pool size); equals preAllocatedVUs in rate mode. */
  readonly replayVus: number;
  /** Wall-clock rps the plan aims at: busiest second for replay, RPS for rate. */
  readonly peakRps: number;
  /** Replay only: wall-clock offset per pool index (ms) and planned length. */
  readonly offsets: readonly number[];
  readonly plannedMs: number | null;
}

export interface LoadInput {
  readonly config: Config;
  /** Sorted pool timestamps (ms). */
  readonly timestamps: readonly number[];
  /** Average request duration measured by discover probes, if known. */
  readonly probeLatencyMs?: number | null;
}

/** Scenario + VU allocation for the configured mode. */
export function buildLoadPlan(input: LoadInput): LoadPlan {
  const { config, timestamps } = input;
  const latency = input.probeLatencyMs ?? null;
  if (config.mode === 'rate') {
    const vus = allocateVus(config.rps, config.vus, config.maxVus, latency);
    return {
      scenario: {
        executor: 'constant-arrival-rate',
        rate: config.rps,
        timeUnit: '1s',
        duration: config.duration,
        preAllocatedVUs: vus.preAllocatedVUs,
        maxVUs: vus.maxVUs,
        gracefulStop: config.timeout,
      },
      vus,
      replayVus: vus.preAllocatedVUs,
      peakRps: config.rps,
      offsets: [],
      plannedMs: null,
    };
  }
  const offsets = buildOffsets(timestamps);
  const peak = peakRps(offsets, config.ratio);
  const vus = allocateVus(peak, config.vus, config.maxVus, latency);
  const replayVus = Math.max(1, Math.min(vus.preAllocatedVUs, timestamps.length));
  return {
    scenario: {
      executor: 'per-vu-iterations',
      vus: replayVus,
      iterations: Math.max(1, iterationsPerVu(timestamps.length, replayVus)),
      maxDuration: replayMaxDuration(offsets, config.ratio, config.timeoutMs),
      gracefulStop: config.timeout,
    },
    vus,
    replayVus,
    peakRps: peak,
    offsets,
    plannedMs: replaySpanMs(offsets, config.ratio),
  };
}

export interface OptionsInput {
  readonly config: Config;
  readonly load: LoadPlan;
  readonly topEndpoints: readonly EndpointCount[];
}

/** Full k6 options object for replay.ts. */
export function buildOptions(input: OptionsInput): Record<string, unknown> {
  return {
    scenarios: { [SCENARIO_NAME]: input.load.scenario },
    thresholds: buildThresholds(input.topEndpoints),
    summaryTrendStats: [...TREND_STATS],
    insecureSkipTLSVerify: input.config.insecure,
    discardResponseBodies: false,
    userAgent: input.config.userAgent === 'log' ? undefined : input.config.userAgent,
  };
}
