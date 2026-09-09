import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/config.ts';
import { discoverSchema, walkDebug } from '../../src/lib/debug-walker.ts';
import { buildReport, renderReport, type K6SummaryData } from '../../src/lib/summary.ts';

const trend = (avg: number, p95: number, p99: number, max: number, med = avg) => ({
  type: 'trend' as const,
  contains: 'time',
  values: { avg, min: 0, med, 'p(90)': p95, 'p(95)': p95, 'p(99)': p99, max },
});
const counter = (count: number, rate = 0) => ({ type: 'counter' as const, contains: 'default', values: { count, rate } });
const rate = (value: number) => ({ type: 'rate' as const, contains: 'default', values: { rate: value, passes: 0, fails: 0 } });

const schema = discoverSchema('debug', [walkDebug({ mongo: { read: { time: 1, num: 1 } }, clickhouse: { time: 1, num: 1 }, memory: { usage: 1, peak: 2 } })]);

const data: K6SummaryData = {
  state: { testRunDurationMs: 12_000 },
  metrics: {
    http_reqs: counter(120, 10),
    http_req_duration: trend(50, 120, 300, 900, 40),
    http_req_failed: rate(0.05),
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
    'http_req_failed{endpoint:/a}': rate(0.01),
    'http_reqs{endpoint:/b}': counter(20),
    'http_req_duration{endpoint:/b}': trend(80, 200, 300, 400, 70),
    'http_req_failed{endpoint:/b}': rate(0.25),
    'http_reqs{endpoint:/never}': counter(0),
  },
};

const ctx = {
  config: parseConfig({ PREFIX: 'http://h', RATIO: '2', VUS: '10' }),
  schema,
  pool: { total: 130, kept: 120, spanMs: 24_000, originalRps: 5 },
  malformed: 4,
};

describe('buildReport', () => {
  const report = buildReport(data, ctx);

  it('fills the header', () => {
    expect(report.header).toMatchObject({
      mode: 'replay',
      prefix: 'http://h',
      poolTotal: 130,
      poolKept: 120,
      malformed: 4,
      spanMs: 24_000,
      originalRps: 5,
      ratio: 2,
      vus: 10,
      testDurationMs: 12_000,
      requests: 120,
      achievedRps: 10,
    });
  });

  it('fills http with lag', () => {
    expect(report.http).toEqual({
      count: 120,
      failedRate: 0.05,
      mismatches: 3,
      avg: 50,
      p50: 40,
      p95: 120,
      p99: 300,
      max: 900,
      lagP95: 20,
      lagMax: 60,
    });
  });

  it('merges component kinds per path and sorts by p95', () => {
    expect(report.components.map((r) => r.path)).toEqual(['clickhouse', 'mongo.read', 'memory']);
    expect(report.components[0]).toEqual({ path: 'clickhouse', avg: 30, p95: 90, p99: 200, max: 700, num: 120, usage: null, peak: null });
    expect(report.components[2]).toMatchObject({ path: 'memory', usage: 100, peak: 300, num: null });
  });

  it('lists endpoints with samples sorted by count', () => {
    expect(report.endpoints).toEqual([
      { endpoint: '/a', count: 100, failedRate: 0.01, p50: 35, p95: 100, max: 900 },
      { endpoint: '/b', count: 20, failedRate: 0.25, p50: 70, p95: 200, max: 400 },
    ]);
  });

  it('reports debug health', () => {
    expect(report.debug).toEqual({ enabled: true, missing: 2, unknownPaths: 0 });
  });

  it('prefers the allocated VU count when given', () => {
    expect(buildReport(data, { ...ctx, vus: 3 }).header.vus).toBe(3);
  });

  it('handles rate mode without lag and without schema', () => {
    const rateReport = buildReport(
      { metrics: { http_reqs: counter(5, 1), http_req_duration: trend(1, 2, 3, 4) } },
      { ...ctx, schema: null, config: parseConfig({ PREFIX: 'http://h', MODE: 'rate' }) },
    );
    expect(rateReport.http.lagP95).toBeNull();
    expect(rateReport.components).toEqual([]);
    expect(rateReport.debug.enabled).toBe(false);
    expect(rateReport.endpoints).toEqual([]);
  });
});

describe('renderReport', () => {
  it('renders all sections in plain text', () => {
    const text = renderReport(buildReport(data, ctx), 15, false);
    expect(text).toContain('mode=replay');
    expect(text).toContain('120 of 130 log entries, 4 malformed lines skipped');
    expect(text).toContain('ratio x2 (target 10 rps), max 10 VUs');
    expect(text).toContain('failed (5xx/transport) 5.00%   status != log 3');
    expect(text).toContain('schedule lag p95 20.0ms  max 60.0ms');
    expect(text).toContain('COMPONENTS');
    expect(text).toMatch(/clickhouse\s+30\.0ms\s+90\.0ms\s+200ms\s+700ms\s+120/);
    expect(text).toContain('2 responses without a debug block');
    expect(text).toMatch(/\/b\s+20\s+25\.00%\s+70\.0ms\s+200ms\s+400ms/);
    expect(text).not.toContain('[');
  });

  it('explains the missing schema and colors the output', () => {
    const text = renderReport(buildReport(data, { ...ctx, schema: null }), 15, true);
    expect(text).toContain('run discover.ts first');
    expect(text).toContain('[1m');
  });
});
