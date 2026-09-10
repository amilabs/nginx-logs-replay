/**
 * k6 glue: loads the log once into a SharedArray and the debug schema file.
 * Only entry scripts and this `src/k6/` folder may import from `k6/*`.
 */

import { SharedArray } from 'k6/data';
import type { Config } from '../lib/config.ts';
import { metricCollisions, parseSchema, type DebugSchema } from '../lib/debug-walker.ts';
import { parseHistory, type HistoryRun } from '../lib/history.ts';
import { parseLog } from '../lib/nginx-parser.ts';
import { buildPool, poolStats, type PoolEntry, type PoolStats } from '../lib/request-pool.ts';

export interface PoolMeta {
  readonly stats: PoolStats;
  readonly malformed: number;
}

export interface LoadedPool {
  readonly pool: readonly PoolEntry[];
  readonly meta: PoolMeta;
}

let cache: LoadedPool | null = null;

function readFile(path: string, what: string): string {
  try {
    return open(path);
  } catch (error) {
    throw new Error(`Cannot read ${what} "${path}": ${String(error)}`);
  }
}

function load(config: Config): LoadedPool {
  if (cache) return cache;
  const parsed = parseLog(readFile(config.log, 'LOG file'), config.format);
  const pool = buildPool(parsed.entries, config);
  if (pool.length === 0) {
    throw new Error(
      `No requests to replay: ${parsed.entries.length} parsed, ${parsed.malformed} malformed lines in "${config.log}" (check FORMAT, FILTER_ONLY/FILTER_SKIP, START_TS)`,
    );
  }
  cache = {
    pool,
    meta: { stats: poolStats(parsed.entries.length + parsed.malformed, pool), malformed: parsed.malformed },
  };
  return cache;
}

/**
 * Pool and its metadata, parsed once and shared across VUs.
 * Both SharedArray callbacks run in the same (first) init context, so the
 * module-level cache guarantees a single parse.
 */
export function sharedPool(config: Config): LoadedPool {
  const pool = new SharedArray('nginx-logs-replay:pool', () => [...load(config).pool]) as unknown as readonly PoolEntry[];
  const metas = new SharedArray('nginx-logs-replay:meta', () => [load(config).meta]) as unknown as readonly PoolMeta[];
  const meta = metas[0];
  if (!meta) throw new Error('Pool metadata missing');
  return { pool, meta };
}

/**
 * Computes a JSON-serializable value once (in the first VU) and shares it
 * with every other VU. k6 re-runs the init context per VU, so anything
 * derived from the whole pool must go through here or init time explodes.
 */
export function sharedOnce<T>(name: string, compute: () => T): T {
  const holder = new SharedArray(`nginx-logs-replay:${name}`, () => [compute()]) as unknown as readonly T[];
  const value = holder[0];
  if (value === undefined) throw new Error(`Shared value "${name}" missing`);
  return value;
}

/** Earlier runs from the HISTORY file; missing or malformed file = empty. */
export function loadHistory(config: Config): HistoryRun[] {
  if (!config.history) return [];
  try {
    return parseHistory(open(config.history));
  } catch {
    return [];
  }
}

/** Timestamps of the pool in order (for schedule offsets). */
export function poolTimestamps(pool: readonly PoolEntry[]): number[] {
  const out: number[] = new Array(pool.length);
  for (let i = 0; i < pool.length; i += 1) out[i] = pool[i]?.ts ?? 0;
  return out;
}

/**
 * Debug schema from DEBUG_SCHEMA. A missing file disables component
 * metrics (returns null); an invalid file is an error.
 */
export function loadSchema(config: Config): DebugSchema | null {
  if (config.debugSchema === 'none') return null;
  let text: string;
  try {
    text = open(config.debugSchema);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`DEBUG_SCHEMA "${config.debugSchema}" is not valid JSON: ${String(error)}`);
  }
  const schema = parseSchema(raw);
  if (!schema) throw new Error(`DEBUG_SCHEMA "${config.debugSchema}" has an unexpected shape; re-run discover.ts`);
  const collisions = metricCollisions(schema);
  if (collisions.length > 0) throw new Error(`DEBUG_SCHEMA has colliding metric names:\n  ${collisions.join('\n  ')}`);
  return schema;
}
