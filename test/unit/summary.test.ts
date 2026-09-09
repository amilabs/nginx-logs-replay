import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/config.ts';
import { discoverSchema, walkDebug } from '../../src/lib/debug-walker.ts';
import { buildReport, capacityWarning, renderReport, type K6SummaryData } from '../../src/lib/summary.ts';

export const trend = (avg: number, p95: number, p99: number, max: number, med = avg) => ({
  type: 'trend' as const,
  contains: 'time',
  values: { avg, min: 1, med, 'p(75)': (med + p95) / 2, 'p(90)': p95, 'p(95)': p95, 'p(99)': p99, 'p(99.9)': max, max },
});
export const counter = (count: number, rate = 0) => ({ type: 'counter' as const, contains: 'default', values: { count, rate } });
export const rateMetric = (value: number, passes = 0) => ({ type: 'rate' as const, contains: 'default', values: { rate: value, passes, fails: 0 } });

export const schema = discoverSchema('debug', [
  walkDebug({ mongo: { read: { time: 1, num: 1 } }, clickhouse: { time: 1, num: 1 }, memory: { usage: 1, peak: 2 } }),
]);

export const data: K6SummaryData = {
  state: { testRunDurationMs: 12_000 },
  metrics: {
    http_reqs: counter(120, 10),
    http_req_duration: trend(50, 120, 300, 900, 40),
    http_req_waiting: trend(45, 110, 280, 880, 36),
    http_req_connecting: trend(2, 3, 4, 5),
    http_req_tls_handshaking: trend(8, 9, 10, 11),
    http_req_failed: rateMetric(0.05, 6),
    data_received: counter(240_000),
    data_sent: counter(12_000),
    replay_status_mismatch: counter(3),
    replay_lag_ms: trend(5, 20, 40, 60),
    debug_missing: counter(2),
    debug_unknown_paths: counter(0),
    dbg_mongo_read_time: trend(10, 30, 50, 80),
    dbg_mongo_read_num: counter(240),
    dbg_clickhouse_time: trend(30, 90, 200, 700),
    dbg_clickhouse_num: counter(120),
    dbg_memory_usage: trend(100, 150, 160, 170),
    dbg_memory_peak: trend(200, 250, 260, 300),
    'http_reqs{endpoint:/a}': counter(100),
    'http_req_duration{endpoint:/a}': trend(40, 100, 250, 900, 35),
    'http_req_failed{endpoint:/a}': rateMetric(0.01),
    'replay_status_mismatch{endpoint:/a}': counter(3),
    'replay_status_mismatch{from:429,to:200}': counter(2),
    'replay_status_mismatch{from:200,to:503}': counter(1),
    'replay_status_mismatch{from:404,to:200}': counter(0),
    'http_reqs{endpoint:/b}': counter(20),
    'http_req_duration{endpoint:/b}': trend(80, 200, 300, 400, 70),
    'http_req_failed{endpoint:/b}': rateMetric(0.25),
    'http_reqs{endpoint:/never}': counter(0),
    'http_reqs{load:3}': counter(60),
    'http_req_duration{load:3}': trend(40, 60, 90, 120, 38),
    'http_req_failed{load:3}': rateMetric(0),
    'http_reqs{load:6}': counter(40),
    'http_req_duration{load:6}': trend(45, 80, 120, 150, 40),
    'http_req_failed{load:6}': rateMetric(0),
    'http_reqs{load:12}': counter(30),
    'http_req_duration{load:12}': trend(300, 900, 1500, 2000, 250),
    'http_req_failed{load:12}': rateMetric(0),
  },
};

export const ctx = {
  config: parseConfig({ PREFIX: 'http://h', RATIO: '2', VUS: '10' }),
  schema,
  pool: { total: 130, kept: 120, spanMs: 24_000, originalRps: 5, firstTs: Date.UTC(2026, 8, 10, 12, 0, 0), lastTs: Date.UTC(2026, 8, 10, 12, 0, 24) },
  malformed: 4,
  vus: { preAllocatedVUs: 10, maxVUs: 200, auto: false, assumedLatencyMs: 250 },
  targetRps: 12,
  plannedMs: 12_000,
  finishedAt: new Date(Date.UTC(2026, 8, 11, 8, 0, 12)),
};

describe('buildReport', () => {
  const report = buildReport(data, ctx);

  it('fills the header with run and log windows', () => {
    expect(report.header).toMatchObject({
      mode: 'replay',
      prefix: 'http://h',
      startedAt: '2026-09-11T08:00:00.000Z',
      finishedAt: '2026-09-11T08:00:12.000Z',
      testDurationMs: 12_000,
      poolTotal: 130,
      poolKept: 120,
      malformed: 4,
      logFrom: '2026-09-10T12:00:00.000Z',
      logTo: '2026-09-10T12:00:24.000Z',
      spanMs: 24_000,
      originalRps: 5,
      targetRps: 12,
      achievedRps: 10,
      ratio: 2,
      plannedMs: 12_000,
      vus: 10,
      maxVus: 200,
      vusAuto: false,
      requests: 120,
    });
  });

  it('fills http with percentiles, ttfb, traffic and lag', () => {
    expect(report.http).toMatchObject({
      count: 120,
      failedRate: 0.05,
      failed: 6,
      mismatches: 3,
      mismatchPairs: [
        { from: 429, to: 200, count: 2 },
        { from: 200, to: 503, count: 1 },
      ],
      duration: { min: 1, avg: 50, p50: 40, p75: 80, p90: 120, p95: 120, p99: 300, p999: 900, max: 900 },
      ttfb: { avg: 45, p95: 110 },
      connectingAvg: 2,
      tlsAvg: 8,
      dataReceived: 240_000,
      dataSent: 12_000,
      avgBodyBytes: 2000,
      lagP95: 20,
      lagMax: 60,
    });
  });

  it('merges component kinds per path and sorts by p95', () => {
    expect(report.components.map((r) => r.path)).toEqual(['clickhouse', 'mongo.read', 'memory']);
    expect(report.components[0]).toMatchObject({ path: 'clickhouse', time: { avg: 30, p95: 90, p99: 200, max: 700 }, num: 120, usage: null, peak: null });
    expect(report.components[2]).toMatchObject({ path: 'memory', time: null, usage: 100, peak: 300, num: null });
  });

  it('lists endpoints with rps and mismatches sorted by count', () => {
    expect(report.endpoints.map((e) => e.endpoint)).toEqual(['/a', '/b']);
    expect(report.endpoints[0]).toMatchObject({ endpoint: '/a', count: 100, rps: 100 / 12, failedRate: 0.01, mismatches: 3, duration: { p50: 35, p95: 100, max: 900 } });
    expect(report.endpoints[1]).toMatchObject({ endpoint: '/b', count: 20, failedRate: 0.25, mismatches: 0 });
  });

  it('finds the load knee and recommends the next ratio', () => {
    expect(report.capacity.rows.map((r) => r.upToRps)).toEqual([3, 6, 12]);
    expect(report.capacity).toMatchObject({ referenceP95: 60, healthyUpToRps: 6, degradedFromRps: 12, nextRatio: 1, safeRatio: 1 });
    expect(report.capacity.verdict).toContain('Latency stays flat up to ~6 rps and starts to climb around ~12 rps');
    expect(report.capacity.verdict).toContain('The log peaks at 6 rps, so the estimated no-degradation level is RATIO x1. Suggested next run: RATIO=1 to confirm');
  });

  it('reports debug health', () => {
    expect(report.debug).toEqual({ enabled: true, missing: 2, unknownPaths: 0 });
  });

  it('diagnoses a load generator bottleneck with a VUS suggestion', () => {
    const slow: K6SummaryData = {
      state: { testRunDurationMs: 120_000 },
      metrics: {
        ...data.metrics,
        http_reqs: counter(9237, 76.2),
        iteration_duration: trend(65, 176, 451, 1242, 39),
        dropped_iterations: counter(12_883),
        replay_lag_ms: trend(50_000, 92_122, 95_000, 96_734),
      },
    };
    const report = buildReport(slow, {
      ...ctx,
      config: parseConfig({ PREFIX: 'http://h', RATIO: '60', VUS: '5' }),
      pool: { ...ctx.pool, kept: 22_120, spanMs: 3_599_000, originalRps: 6.146 },
      vus: { preAllocatedVUs: 5, maxVUs: 200, auto: false, assumedLatencyMs: 250 },
      targetRps: 368.76,
      plannedMs: 60_000,
    });
    expect(report.http.dropped).toBe(12_883);
    expect(report.http.suggestedVus).toBe(54);
    const text = renderReport(report, 15, false);
    expect(text).toContain('Timeline not kept: requests fired late by p50 50.00s, p95 92.12s, max 96.73s because all 5 VUs were busy');
    expect(text).toContain('12883 requests were never sent');
    expect(text).toContain('VUs were fixed at 5; responses stayed fast');
    expect(text).toContain('Use a bigger agent or set VUS=54, or lower RATIO/RPS');
    const tail = buildReport({ ...slow, metrics: { ...slow.metrics, dropped_iterations: counter(0), replay_lag_ms: trend(800, 7137, 12795, 19058, 0) } }, { ...ctx, vus: { preAllocatedVUs: 176, maxVUs: 704, auto: true, assumedLatencyMs: 250 }, targetRps: 352, plannedMs: 180_000 });
    expect(renderReport(tail, 15, false)).toContain('Timeline kept for 90% of requests; a tail fired late (p95 lag 7.14s, max 19.06s) while all 176 VUs were busy during bursts: responses stayed fast');
    const lagTail = { type: 'trend' as const, contains: 'time', values: { avg: 50, min: 0, med: 0, 'p(75)': 0, 'p(90)': 0, 'p(95)': 1100, 'p(99)': 3000, 'p(99.9)': 7000, max: 7590 } };
    const smallTail = buildReport({ ...slow, metrics: { ...slow.metrics, dropped_iterations: counter(0), replay_lag_ms: lagTail } }, { ...ctx, vus: { preAllocatedVUs: 111, maxVUs: 444, auto: true, assumedLatencyMs: 500 }, targetRps: 220, plannedMs: 180_000 });
    expect(capacityWarning(smallTail)).toBeNull();
    const autoSevere = buildReport(slow, { ...ctx, vus: { preAllocatedVUs: 111, maxVUs: 444, auto: true, assumedLatencyMs: 500 }, targetRps: 220, plannedMs: 180_000, probeAvgMs: 77.5 });
    expect(capacityWarning(autoSevere)).toContain('VUs were sized automatically (111 from the 77.5ms at discover latency)');
    expect(capacityWarning(autoSevere)).not.toContain('VUS=');
    const saturated = buildReport({ ...slow, metrics: { ...slow.metrics, http_req_duration: trend(1200, 5227, 9000, 18047, 40) } }, { ...ctx, vus: { preAllocatedVUs: 227, maxVUs: 900, auto: true, assumedLatencyMs: 250 }, targetRps: 453, plannedMs: 120_000, probeAvgMs: 83.6 });
    expect(renderReport(saturated, 15, false)).toContain('responses slowed to p95 5.23s (max 18.05s) vs 83.6ms at discover, so the target saturated');
    expect(buildReport(data, ctx).http).toMatchObject({ dropped: 0, suggestedVus: null });
  });

  it('handles rate mode without lag and without schema', () => {
    const rateReport = buildReport(
      { metrics: { http_reqs: counter(5, 1), http_req_duration: trend(1, 2, 3, 4) } },
      { ...ctx, schema: null, config: parseConfig({ PREFIX: 'http://h', MODE: 'rate', RPS: '7' }), targetRps: 7, plannedMs: null, vus: { preAllocatedVUs: 10, maxVUs: 200, auto: true, assumedLatencyMs: 250 } },
    );
    expect(rateReport.header.targetRps).toBe(7);
    expect(rateReport.header.vusAuto).toBe(true);
    expect(rateReport.header.startedAt).toBe(rateReport.header.finishedAt);
    expect(rateReport.http.lagP95).toBeNull();
    expect(rateReport.http.ttfb.avg).toBe(0);
    expect(rateReport.components).toEqual([]);
    expect(rateReport.debug.enabled).toBe(false);
    expect(rateReport.endpoints).toEqual([]);
    expect(rateReport.capacity.rows).toEqual([]);
    expect(rateReport.capacity.verdict).toContain('Not enough data');
  });

  it('judges a rate run against the probe baseline', () => {
    const rateData: K6SummaryData = {
      metrics: {
        http_reqs: counter(50, 5),
        http_req_duration: trend(40, 90, 120, 150, 38),
        'http_reqs{load:5}': counter(50),
        'http_req_duration{load:5}': trend(40, 90, 120, 150, 38),
        'http_req_failed{load:5}': rateMetric(0),
      },
    };
    const okRun = buildReport(rateData, { ...ctx, config: parseConfig({ PREFIX: 'http://h', MODE: 'rate', RPS: '5' }), targetRps: 5, plannedMs: null, probeAvgMs: 60 });
    expect(okRun.capacity.verdict).toContain('No degradation at 5 rps (p95 90ms vs 60ms baseline). Try RPS=8');
    const slowRun = buildReport(rateData, { ...ctx, config: parseConfig({ PREFIX: 'http://h', MODE: 'rate', RPS: '5' }), targetRps: 5, plannedMs: null, probeAvgMs: 10 });
    expect(slowRun.capacity.verdict).toContain('Degraded at 5 rps: p95 90ms vs 10ms baseline. Try RPS=4');
  });
});

describe('renderReport', () => {
  it('renders all sections in plain text', () => {
    const text = renderReport(buildReport(data, ctx), 15, false);
    expect(text).toContain('mode=replay');
    expect(text).toContain('run:       2026-09-11T08:00:00.000Z → 2026-09-11T08:00:12.000Z (12.0s)');
    expect(text).toContain('120 of 130 log entries, 4 malformed lines skipped');
    expect(text).toContain('2026-09-10T12:00:00.000Z → 2026-09-10T12:00:24.000Z, 24.0s span, 5 rps');
    expect(text).toContain('ratio x2 (planned 12.0s, busiest second 12 rps), fixed VUs 10');
    expect(text).toContain('failed (5xx/transport) 6 (5.00%)   status != log 3   received 234.4 KB (avg 2.0 KB/resp)   sent 11.7 KB');
    expect(text).toMatch(/duration\s+1\.00ms\s+50\.0ms\s+40\.0ms\s+120ms\s+120ms\s+300ms\s+900ms/);
    expect(text).toMatch(/ttfb\s+1\.00ms\s+45\.0ms/);
    expect(text).toContain('status != log by pair (log→replay): 429→200 ×2, 200→503 ×1');
    expect(text).toContain('schedule lag p95 20.0ms  max 60.0ms');
    expect(text).toContain('LOAD vs LATENCY');
    expect(text).toMatch(/12\s+30\s+0\.00%\s+250ms\s+900ms\s+1\.50s\s+2\.00s\s+climbing/);
    expect(text).toContain('Suggested next run: RATIO=1');
    expect(text).toContain('COMPONENTS');
    expect(text).toMatch(/clickhouse\s+1\.00ms\s+30\.0ms\s+30\.0ms\s+90\.0ms\s+90\.0ms\s+200ms\s+700ms\s+120/);
    expect(text).toContain('2 responses without a debug block');
    expect(text).toMatch(/\/a\s+100\s+8\.33\s+1\.00%\s+3\s+/);
    expect(text).toMatch(/\/b\s+20\s+1\.67\s+25\.00%\s+0\s+/);
    expect(text).not.toContain('[');
  });

  it('explains the missing schema and colors the output', () => {
    const text = renderReport(buildReport(data, { ...ctx, schema: null }), 15, true);
    expect(text).toContain('run discover.ts first');
    expect(text).toContain('[1m');
  });
});
