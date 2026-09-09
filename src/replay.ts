/**
 * nginx-logs-replay — k6 entry point.
 *
 *   k6 run -e PREFIX=https://host -e LOG=access.log src/replay.ts
 *
 * MODE=replay (default) follows the log timeline (RATIO speeds it up);
 * MODE=rate fires the pool at a fixed RPS. See README for every option.
 */

import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import type { Options } from 'k6/options';
import { parseConfig } from './lib/config.ts';
import { buildOptions, replayVus } from './lib/options.ts';
import { topEndpoints } from './lib/request-pool.ts';
import { buildOffsets, poolIndex, targetTime } from './lib/schedule.ts';
import { buildReport, renderReport, type K6SummaryData } from './lib/summary.ts';
import { declareDebugMetrics, replayLag } from './k6/metrics.ts';
import { loadSchema, poolTimestamps, sharedPool } from './k6/pool.ts';
import { createRequestContext, performRequest } from './k6/request.ts';

const config = parseConfig(__ENV);
const { pool, meta } = sharedPool(config);
const offsets = buildOffsets(poolTimestamps(pool));
const schema = loadSchema(config);
const requestContext = createRequestContext(config, declareDebugMetrics(schema, config.debugTimeFactor));
const vus = replayVus(config, pool.length);

// 4xx are legitimate replayed responses; only 5xx and transport errors count as failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const options = buildOptions({
  config,
  poolSize: pool.length,
  offsets,
  topEndpoints: topEndpoints(pool, config.top, config.normalizeEndpoints),
}) as Options;

export function setup(): void {
  const { stats } = meta;
  console.log(
    `pool: ${stats.kept} requests (${meta.malformed} malformed lines skipped), original span ${Math.round(stats.spanMs / 1000)}s at ${stats.originalRps.toFixed(2)} rps`,
  );
  if (schema) {
    console.log(`debug schema: ${schema.entries.length} metrics from "${config.debugSchema}" (field "${schema.field}")`);
  } else {
    console.warn(`no debug schema at "${config.debugSchema}": component metrics disabled, run src/discover.ts first`);
  }
}

function pickIndex(): number | null {
  if (config.mode === 'rate') return exec.scenario.iterationInTest % pool.length;
  const index = poolIndex(exec.vu.idInTest, exec.vu.iterationInScenario, vus);
  return index < pool.length ? index : null;
}

function waitForSlot(index: number): void {
  const target = targetTime(exec.scenario.startTime, offsets[index] ?? 0, config.ratio);
  const wait = target - Date.now();
  if (wait > 0) {
    sleep(wait / 1000);
    replayLag.add(0);
  } else {
    replayLag.add(-wait);
  }
}

export default function (): void {
  const index = pickIndex();
  if (index === null) return;
  const entry = pool[index];
  if (!entry) return;
  if (config.mode === 'replay') waitForSlot(index);
  const nonce = `${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Date.now()}`;
  performRequest(requestContext, entry, nonce);
}

export function handleSummary(data: K6SummaryData): Record<string, string> {
  const report = buildReport(data, {
    config,
    schema,
    pool: meta.stats,
    malformed: meta.malformed,
    vus: config.mode === 'replay' ? vus : config.vus,
  });
  return {
    stdout: renderReport(report, config.top, config.colors),
    [config.summaryJson]: JSON.stringify({ report, k6: data }, null, 2),
  };
}
