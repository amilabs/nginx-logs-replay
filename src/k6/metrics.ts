/**
 * k6 glue: custom metrics. Debug component metrics are declared from the
 * schema in the init context; samples are recorded per response.
 */

import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { scaleTimeSamples, schemaKey, walkDebug, type DebugSchema } from '../lib/debug-walker.ts';

export const replayLag = new Trend('replay_lag_ms', true);
export const statusMismatch = new Counter('replay_status_mismatch');

export interface DebugMetrics {
  readonly schema: DebugSchema;
  readonly byKey: ReadonlyMap<string, Trend | Counter>;
  readonly missing: Counter;
  readonly unknown: Counter;
  /** Multiplier turning debug `time` values into milliseconds. */
  readonly timeFactor: number;
}

/** Declares one Trend/Counter per schema entry. Must run in the init context. */
export function declareDebugMetrics(schema: DebugSchema | null, timeFactor = 1): DebugMetrics | null {
  if (!schema) return null;
  const byKey = new Map<string, Trend | Counter>();
  for (const entry of schema.entries) {
    const metric = entry.kind === 'num' ? new Counter(entry.metric) : new Trend(entry.metric, entry.kind === 'time');
    byKey.set(schemaKey(entry.path, entry.kind), metric);
  }
  return { schema, byKey, missing: new Counter('debug_missing'), unknown: new Counter('debug_unknown_paths'), timeFactor };
}

const warnedPaths = new Set<string>();

function warnUnknown(path: string): void {
  if (warnedPaths.has(path) || exec.vu.idInTest !== 1) return;
  warnedPaths.add(path);
  console.warn(`debug path "${path}" is not in the schema; re-run discover.ts to include it`);
}

/** Records samples from a debug object; `undefined` counts as missing. */
export function recordDebug(metrics: DebugMetrics, debug: unknown, tags: Record<string, string>): void {
  if (debug === undefined || debug === null) {
    metrics.missing.add(1, tags);
    return;
  }
  const samples = scaleTimeSamples(walkDebug(debug), metrics.timeFactor);
  if (samples.length === 0) {
    metrics.missing.add(1, tags);
    return;
  }
  for (const sample of samples) {
    const metric = metrics.byKey.get(schemaKey(sample.path, sample.kind));
    if (metric) {
      metric.add(sample.value, tags);
    } else {
      metrics.unknown.add(1, tags);
      warnUnknown(sample.path);
    }
  }
}
