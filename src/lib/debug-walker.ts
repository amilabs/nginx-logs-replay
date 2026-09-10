/**
 * Walks the `debug` block of a JSON response into metric samples and
 * discovers the metric schema. Rules are inherited from v1:
 *  - object with time/num/queries -> time, num, and time per queries.<name>;
 *    `totalQueries` (raw Ethplorer profile) or the length of a `queries`
 *    array stand in for `num` when it is absent
 *  - object with usage            -> usage, peak
 *  - other object                 -> recurse with dotted prefix
 *  - number                       -> time
 * Pure: no k6 imports.
 */

export type Kind = 'time' | 'num' | 'usage' | 'peak';

export interface Sample {
  readonly path: string;
  readonly kind: Kind;
  readonly value: number;
}

export interface SchemaEntry {
  readonly path: string;
  readonly kind: Kind;
  /** k6 metric name, e.g. `dbg_clickhouse_time`. */
  readonly metric: string;
}

export interface DebugSchema {
  readonly field: string;
  readonly entries: readonly SchemaEntry[];
  /** Average request duration (ms) measured by discover probes; used to size VUs. */
  readonly probeAvgMs?: number;
}

const MAX_METRIC_NAME = 128;
const MAX_DEPTH = 8;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function join(prefix: string, field: string): string {
  return prefix === '' ? field : `${prefix}.${field}`;
}

/** k6 metric name for a path/kind: `dbg_` + sanitized path + `_` + kind. */
export function metricName(path: string, kind: Kind): string {
  const sanitized = path.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const name = `dbg_${sanitized}_${kind}`;
  return name.length > MAX_METRIC_NAME ? name.slice(0, MAX_METRIC_NAME) : name;
}

export function schemaKey(path: string, kind: Kind): string {
  return `${path}#${kind}`;
}

function walkQueries(queries: unknown, prefix: string, out: Sample[]): void {
  if (!isDict(queries)) return;
  for (const [name, value] of Object.entries(queries)) {
    if (isNumber(value)) out.push({ path: join(prefix, name), kind: 'time', value });
  }
}

/** `num`, or the raw-profile equivalents: `totalQueries` or a `queries` array. */
function queryCount(value: Dict): number | undefined {
  if (isNumber(value.num)) return value.num;
  if (isNumber(value.totalQueries)) return value.totalQueries;
  if (Array.isArray(value.queries)) return value.queries.length;
  return undefined;
}

function walkInto(obj: Dict, prefix: string, out: Sample[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const [field, value] of Object.entries(obj)) {
    const path = join(prefix, field);
    if (isNumber(value)) {
      out.push({ path, kind: 'time', value });
      continue;
    }
    if (!isDict(value)) continue;
    const hasTiming = 'time' in value || 'num' in value || 'totalQueries' in value || 'queries' in value;
    if (hasTiming) {
      if (isNumber(value.time)) out.push({ path, kind: 'time', value: value.time });
      const num = queryCount(value);
      if (num !== undefined) out.push({ path, kind: 'num', value: num });
      walkQueries(value.queries, path, out);
      continue;
    }
    if ('usage' in value) {
      if (isNumber(value.usage)) out.push({ path, kind: 'usage', value: value.usage });
      if (isNumber(value.peak)) out.push({ path, kind: 'peak', value: value.peak });
      continue;
    }
    walkInto(value, path, out, depth + 1);
  }
}

/** Flattens a debug object into samples. Non-objects yield nothing. */
export function walkDebug(debug: unknown): Sample[] {
  const out: Sample[] = [];
  if (isDict(debug)) walkInto(debug, '', out, 0);
  return out;
}

/** Converts `time` samples to milliseconds; other kinds pass through. */
export function scaleTimeSamples(samples: readonly Sample[], factor: number): Sample[] {
  if (factor === 1) return [...samples];
  return samples.map((sample) => (sample.kind === 'time' ? { ...sample, value: sample.value * factor } : sample));
}

/** Reads a dotted path (`data.debug`) from a parsed JSON value. */
export function getByPath(value: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => (isDict(acc) ? acc[key] : undefined), value);
}

/** Union of sample paths across probes, as a sorted schema. */
export function discoverSchema(field: string, probes: readonly (readonly Sample[])[]): DebugSchema {
  const seen = new Map<string, SchemaEntry>();
  for (const samples of probes) {
    for (const sample of samples) {
      const key = schemaKey(sample.path, sample.kind);
      if (!seen.has(key)) {
        seen.set(key, { path: sample.path, kind: sample.kind, metric: metricName(sample.path, sample.kind) });
      }
    }
  }
  const entries = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { field, entries };
}

/** Validates a parsed schema file; returns null when the shape is wrong. */
export function parseSchema(value: unknown): DebugSchema | null {
  if (!isDict(value) || typeof value.field !== 'string' || !Array.isArray(value.entries)) return null;
  const entries: SchemaEntry[] = [];
  for (const raw of value.entries) {
    if (!isDict(raw) || typeof raw.path !== 'string' || typeof raw.kind !== 'string') return null;
    if (!['time', 'num', 'usage', 'peak'].includes(raw.kind)) return null;
    const kind = raw.kind as Kind;
    entries.push({ path: raw.path, kind, metric: metricName(raw.path, kind) });
  }
  const probe = isDict(value.probe) && isNumber(value.probe.avgDurationMs) ? value.probe.avgDurationMs : undefined;
  return probe === undefined ? { field: value.field, entries } : { field: value.field, entries, probeAvgMs: probe };
}

/** Metric names that collide after sanitizing (e.g. `a.b` vs `a_b`). */
export function metricCollisions(schema: DebugSchema): string[] {
  const byMetric = new Map<string, string[]>();
  for (const entry of schema.entries) {
    byMetric.set(entry.metric, [...(byMetric.get(entry.metric) ?? []), `${entry.path}#${entry.kind}`]);
  }
  return [...byMetric.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([metric, paths]) => `${metric} <- ${paths.join(', ')}`);
}
