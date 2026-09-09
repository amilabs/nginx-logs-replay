/**
 * Builds the k6 `options` object for replay/rate modes.
 * Pure: returns a plain object; replay.ts casts it to k6's Options type.
 */

import type { Config } from './config.ts';
import { iterationsPerVu, replayMaxDuration } from './schedule.ts';

export const SCENARIO_NAME = 'nginx_replay';
export const TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'] as const;

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
  }
  return Object.fromEntries(entries);
}

export interface ScenarioInput {
  readonly config: Config;
  readonly poolSize: number;
  readonly offsets: readonly number[];
}

/** VUs actually used by the replay scenario: never more than requests. */
export function replayVus(config: Config, poolSize: number): number {
  return Math.max(1, Math.min(config.vus, poolSize));
}

export function buildScenario(input: ScenarioInput): Record<string, unknown> {
  const { config, poolSize, offsets } = input;
  if (config.mode === 'rate') {
    return {
      executor: 'constant-arrival-rate',
      rate: config.rps,
      timeUnit: '1s',
      duration: config.duration,
      preAllocatedVUs: config.vus,
      maxVUs: config.maxVus,
      gracefulStop: config.timeout,
    };
  }
  const vus = replayVus(config, poolSize);
  return {
    executor: 'per-vu-iterations',
    vus,
    iterations: Math.max(1, iterationsPerVu(poolSize, vus)),
    maxDuration: replayMaxDuration(offsets, config.ratio, config.timeoutMs),
    gracefulStop: config.timeout,
  };
}

export interface OptionsInput extends ScenarioInput {
  readonly topEndpoints: readonly EndpointCount[];
}

/** Full k6 options object for replay.ts. */
export function buildOptions(input: OptionsInput): Record<string, unknown> {
  return {
    scenarios: { [SCENARIO_NAME]: buildScenario(input) },
    thresholds: buildThresholds(input.topEndpoints),
    summaryTrendStats: [...TREND_STATS],
    insecureSkipTLSVerify: input.config.insecure,
    discardResponseBodies: false,
    userAgent: input.config.userAgent === 'log' ? undefined : input.config.userAgent,
  };
}
