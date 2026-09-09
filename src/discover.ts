/**
 * nginx-logs-replay — debug schema discovery.
 *
 *   k6 run -e PREFIX=https://host -e LOG=access.log src/discover.ts
 *
 * Sends the first DISCOVER_N pool entries, walks the debug block of each
 * JSON response and writes DEBUG_SCHEMA (default ./debug-schema.json).
 * replay.ts declares one k6 metric per schema entry.
 */

import type { Options } from 'k6/options';
import { parseConfig } from './lib/config.ts';
import { discoverSchema, scaleTimeSamples, walkDebug, type DebugSchema, type Sample } from './lib/debug-walker.ts';
import { fmtMs, fmtNum, palette, table } from './lib/format.ts';
import { sharedPool } from './k6/pool.ts';
import { createRequestContext, extractDebug, performRequest } from './k6/request.ts';

const config = parseConfig(__ENV);
const { pool } = sharedPool(config);
const requestContext = createRequestContext(config, null);

export const options: Options = { vus: 1, iterations: 1 };

interface Probe {
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly samples: readonly Sample[];
}

interface Discovery {
  readonly schema: DebugSchema;
  readonly probes: readonly Probe[];
}

export function setup(): Discovery {
  const count = Math.min(config.discoverN, pool.length);
  const probes: Probe[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = pool[i];
    if (!entry) continue;
    const res = performRequest(requestContext, entry, `discover-${i}`);
    const debug = extractDebug(res, config.debugField);
    probes.push({
      path: entry.p,
      status: res.status,
      durationMs: res.timings.duration,
      samples: scaleTimeSamples(walkDebug(debug), config.debugTimeFactor),
    });
  }
  const avgDurationMs = probes.length > 0 ? probes.reduce((sum, p) => sum + p.durationMs, 0) / probes.length : 0;
  const schema: DebugSchema = { ...discoverSchema(config.debugField, probes.map((p) => p.samples)), probeAvgMs: avgDurationMs };
  return { schema, probes };
}

export default function (): void {
  // Probing happens in setup(); nothing to do per iteration.
}

interface SummaryData {
  readonly setup_data?: Discovery;
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const c = palette(config.colors);
  const discovery = data.setup_data;
  if (!discovery) return { stdout: c.red('discover: setup() produced no data\n') };
  const { schema, probes } = discovery;
  const firstValues = new Map<string, number>();
  for (const probe of probes) {
    for (const sample of probe.samples) {
      const key = `${sample.path}#${sample.kind}`;
      if (!firstValues.has(key)) firstValues.set(key, sample.value);
    }
  }
  const probeLines = probes.map((p) => `  ${p.status} ${fmtMs(p.durationMs).padStart(7)} ${p.path}  (${p.samples.length} samples)`);
  const lines = [
    '',
    c.bold(c.cyan(`discover: probed ${probes.length} requests against ${config.prefix}, debug field "${config.debugField}"`)),
    ...probeLines,
    '',
  ];
  if (schema.entries.length === 0) {
    lines.push(c.yellow('no debug samples found: check DEBUG_FIELD and that the target returns JSON with a debug block'));
    return { stdout: `${lines.join('\n')}\n` };
  }
  lines.push(
    table(
      ['path', 'kind', 'metric', 'example (time in ms)'],
      schema.entries.map((e) => [e.path, e.kind, e.metric, fmtNum(firstValues.get(`${e.path}#${e.kind}`))]),
      ['left', 'left', 'left', 'right'],
    ),
    '',
    c.green(`schema with ${schema.entries.length} metrics written to ${config.debugSchema} (probe avg ${fmtMs(schema.probeAvgMs)}, used to size VUs)`),
    '',
  );
  return {
    stdout: `${lines.join('\n')}\n`,
    [config.debugSchema]: `${JSON.stringify({ field: schema.field, entries: schema.entries, probe: { avgDurationMs: schema.probeAvgMs ?? 0 } }, null, 2)}\n`,
  };
}
