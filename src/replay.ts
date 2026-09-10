/**
 * nginx-logs-replay — k6 entry point.
 *
 *   k6 run -e PREFIX=https://host -e LOG=access.log src/replay.ts
 *
 * MODE=replay (default) fires every request at exactly its log offset
 * divided by RATIO; MODE=rate fires the pool at a fixed RPS. VUs are sized
 * automatically from the busiest second of the plan and the latency measured
 * by discover.ts (VUS / MAX_VUS override).
 */

import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import type { Options } from 'k6/options';
import { parseConfig } from './lib/config.ts';
import { appendHistory, historyKey, type HistoryRun } from './lib/history.ts';
import { renderHtmlReport } from './lib/html-report.ts';
import { buildLoadPlan, buildOptions } from './lib/options.ts';
import { poolStatuses, topEndpoints } from './lib/request-pool.ts';
import { poolIndex, targetTime } from './lib/schedule.ts';
import { buildReport, renderReport, type K6SummaryData } from './lib/summary.ts';
import { declareDebugMetrics, replayLag } from './k6/metrics.ts';
import { loadHistory, loadSchema, poolTimestamps, sharedOnce, sharedPool } from './k6/pool.ts';
import { createRequestContext, performRequest } from './k6/request.ts';

const config = parseConfig(__ENV);
const { pool, meta } = sharedPool(config);
const schema = loadSchema(config);
const history = loadHistory(config);
// Derived from the whole pool: computed once and shared, not per VU (see sharedOnce).
const derived = sharedOnce('plan', () => ({
  load: buildLoadPlan({ config, timestamps: poolTimestamps(pool), probeLatencyMs: schema?.probeAvgMs ?? null }),
  top: topEndpoints(pool, config.top, config.normalizeEndpoints),
  statuses: poolStatuses(pool),
}));
const load = derived.load;
const requestContext = createRequestContext(config, declareDebugMetrics(schema, config.debugTimeFactor));

// 4xx are legitimate replayed responses; only 5xx and transport errors count as failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const options = buildOptions({
  config,
  load,
  topEndpoints: derived.top,
  logStatuses: derived.statuses,
}) as Options;

export function setup(): void {
  const { stats } = meta;
  const vus = load.vus.auto
    ? `auto VUs: ${load.vus.preAllocatedVUs} (peak ${load.peakRps.toFixed(1)} rps × ${load.vus.assumedLatencyMs}ms assumed latency × 2)`
    : `fixed VUs: ${load.vus.preAllocatedVUs}`;
  console.log(
    `pool: ${stats.kept} requests (${meta.malformed} malformed lines skipped), original span ${Math.round(stats.spanMs / 1000)}s at ${stats.originalRps.toFixed(2)} rps`,
  );
  if (config.mode === 'replay') {
    console.log(`replay plan: ${Math.round((load.plannedMs ?? 0) / 1000)}s at ratio x${config.ratio}, busiest second ${load.peakRps.toFixed(1)} rps; ${vus}`);
  } else {
    console.log(`rate plan: ${config.rps} rps for ${config.duration}; ${vus}, up to ${load.vus.maxVUs}`);
  }
  if (schema) {
    console.log(`debug schema: ${schema.entries.length} metrics from "${config.debugSchema}" (field "${schema.field}")`);
  } else {
    console.warn(`no debug schema at "${config.debugSchema}": component metrics disabled, run src/discover.ts first`);
  }
}

function pickIndex(): number | null {
  if (config.mode === 'rate') return exec.scenario.iterationInTest % pool.length;
  const index = poolIndex(exec.vu.idInTest, exec.vu.iterationInScenario, load.replayVus);
  return index < pool.length ? index : null;
}

function waitForSlot(index: number): void {
  const target = targetTime(exec.scenario.startTime, load.offsets[index] ?? 0, config.ratio);
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
  const loadBucket = config.mode === 'rate' ? String(load.loadEdges[0] ?? '') : (load.loadTags[index] ?? '');
  performRequest(requestContext, entry, nonce, { load: loadBucket });
}

function currentRun(data: K6SummaryData, key: string): HistoryRun {
  const metric = (name: string, value: string): number => data.metrics[name]?.values[value] ?? 0;
  return {
    key,
    at: new Date().toISOString(),
    ratio: config.ratio,
    plannedMs: load.plannedMs ?? 0,
    durationMs: data.state?.testRunDurationMs ?? 0,
    achievedRps: metric('http_reqs', 'rate'),
    requests: metric('http_reqs', 'count'),
    failed: metric('http_req_failed', 'passes'),
    lagP50Ms: metric('replay_lag_ms', 'med'),
    p95Ms: metric('http_req_duration', 'p(95)'),
    label: __ENV.RUN_LABEL,
  };
}

export function handleSummary(data: K6SummaryData): Record<string, string> {
  const key = historyKey({
    prefix: config.prefix,
    mode: config.mode,
    poolKept: meta.stats.kept,
    firstTs: meta.stats.firstTs,
    lastTs: meta.stats.lastTs,
    queryParams: config.queryParams,
    skipStatuses: config.skipStatuses,
    filterOnly: config.filterOnly,
    filterSkip: config.filterSkip,
  });
  const updatedHistory = config.mode === 'replay' ? appendHistory(history, currentRun(data, key)) : [...history];
  const report = buildReport(data, {
    config,
    schema,
    pool: meta.stats,
    malformed: meta.malformed,
    vus: { ...load.vus, preAllocatedVUs: load.replayVus },
    targetRps: load.peakRps,
    plannedMs: load.plannedMs,
    probeAvgMs: schema?.probeAvgMs ?? null,
    history: updatedHistory,
    historyKey: key,
  });
  const outputs: Record<string, string> = {
    stdout: renderReport(report, config.top, config.colors),
    [config.summaryJson]: JSON.stringify({ report, k6: data }, null, 2),
  };
  if (config.summaryHtml) {
    outputs[config.summaryHtml] = renderHtmlReport(report, config.top, {
      dashboardHref: config.dashboardHref || undefined,
    });
  }
  if (config.history && config.mode === 'replay') outputs[config.history] = `${JSON.stringify(updatedHistory, null, 1)}\n`;
  return outputs;
}
