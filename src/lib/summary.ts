/**
 * Turns k6's end-of-test summary data into a report model and renders it as
 * console text. The same model feeds html-report.ts. Pure.
 */

import type { Config } from './config.ts';
import type { DebugSchema } from './debug-walker.ts';
import { fmtBytes, fmtDuration, fmtMs, fmtNum, fmtPct, palette, table } from './format.ts';
import type { PoolStats } from './request-pool.ts';

/** Subset of the k6 handleSummary `data` argument that the report uses. */
export interface K6Metric {
  readonly type: 'trend' | 'counter' | 'rate' | 'gauge';
  readonly contains: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface K6SummaryData {
  readonly metrics: Readonly<Record<string, K6Metric>>;
  readonly state?: { readonly testRunDurationMs?: number };
}

export interface ReportContext {
  readonly config: Config;
  readonly schema: DebugSchema | null;
  readonly pool: PoolStats;
  readonly malformed: number;
  /** VUs actually allocated (replay caps them at the pool size). */
  readonly vus?: number;
  /** Wall-clock end of the run; defaults to now. */
  readonly finishedAt?: Date;
}

/** Latency distribution in ms. */
export interface Percentiles {
  readonly min: number;
  readonly avg: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly p999: number;
  readonly max: number;
}

export interface HeaderSection {
  readonly mode: string;
  readonly prefix: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly testDurationMs: number;
  readonly poolTotal: number;
  readonly poolKept: number;
  readonly malformed: number;
  readonly logFrom: string;
  readonly logTo: string;
  readonly spanMs: number;
  readonly originalRps: number;
  readonly targetRps: number;
  readonly achievedRps: number;
  readonly ratio: number;
  readonly rps: number;
  readonly duration: string;
  readonly vus: number;
  readonly maxVus: number;
  readonly requests: number;
}

export interface HttpSection {
  readonly count: number;
  readonly failedRate: number;
  readonly failed: number;
  readonly mismatches: number;
  readonly duration: Percentiles;
  /** Time to first byte (http_req_waiting). */
  readonly ttfb: Percentiles;
  readonly connectingAvg: number;
  readonly tlsAvg: number;
  readonly dataReceived: number;
  readonly dataSent: number;
  readonly avgBodyBytes: number;
  readonly lagP95: number | null;
  readonly lagMax: number | null;
  /** Iterations k6 never started (replay hit max duration / rate mode had no free VU). */
  readonly dropped: number;
  /** VUs that would have kept up: target rps × avg iteration time × 1.5 (null when not applicable). */
  readonly suggestedVus: number | null;
}

export interface ComponentRow {
  readonly path: string;
  readonly time: Percentiles | null;
  readonly num: number | null;
  readonly usage: number | null;
  readonly peak: number | null;
}

export interface EndpointRow {
  readonly endpoint: string;
  readonly count: number;
  readonly rps: number;
  readonly failedRate: number;
  readonly mismatches: number;
  readonly duration: Percentiles;
}

export interface DebugSection {
  readonly enabled: boolean;
  readonly missing: number;
  readonly unknownPaths: number;
}

export interface Report {
  readonly header: HeaderSection;
  readonly http: HttpSection;
  readonly components: readonly ComponentRow[];
  readonly endpoints: readonly EndpointRow[];
  readonly debug: DebugSection;
}

const SUBMETRIC_RE = /^([a-zA-Z0-9_]+)\{endpoint:(.*)\}$/;

function metricValue(data: K6SummaryData, name: string, key: string): number | null {
  const value = data.metrics[name]?.values[key];
  return value === undefined ? null : value;
}

function num(value: number | null): number {
  return value ?? 0;
}

function percentiles(data: K6SummaryData, name: string): Percentiles | null {
  const metric = data.metrics[name];
  if (!metric) return null;
  const v = metric.values;
  return {
    min: num(v.min ?? null),
    avg: num(v.avg ?? null),
    p50: num(v.med ?? null),
    p75: num(v['p(75)'] ?? null),
    p90: num(v['p(90)'] ?? null),
    p95: num(v['p(95)'] ?? null),
    p99: num(v['p(99)'] ?? null),
    p999: num(v['p(99.9)'] ?? null),
    max: num(v.max ?? null),
  };
}

const EMPTY: Percentiles = { min: 0, avg: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, p999: 0, max: 0 };

function iso(ms: number): string {
  return ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : '-';
}

function buildHeader(data: K6SummaryData, ctx: ReportContext): HeaderSection {
  const testDurationMs = data.state?.testRunDurationMs ?? 0;
  const finished = ctx.finishedAt ?? new Date();
  const mode = ctx.config.mode;
  return {
    mode,
    prefix: ctx.config.prefix,
    startedAt: iso(finished.getTime() - testDurationMs),
    finishedAt: iso(finished.getTime()),
    testDurationMs,
    poolTotal: ctx.pool.total,
    poolKept: ctx.pool.kept,
    malformed: ctx.malformed,
    logFrom: iso(ctx.pool.firstTs),
    logTo: iso(ctx.pool.lastTs),
    spanMs: ctx.pool.spanMs,
    originalRps: ctx.pool.originalRps,
    targetRps: mode === 'replay' ? ctx.pool.originalRps * ctx.config.ratio : ctx.config.rps,
    achievedRps: num(metricValue(data, 'http_reqs', 'rate')),
    ratio: ctx.config.ratio,
    rps: ctx.config.rps,
    duration: ctx.config.duration,
    vus: ctx.vus ?? ctx.config.vus,
    maxVus: mode === 'rate' ? ctx.config.maxVus : (ctx.vus ?? ctx.config.vus),
    requests: num(metricValue(data, 'http_reqs', 'count')),
  };
}

function buildHttp(data: K6SummaryData, header: HeaderSection): HttpSection {
  const count = num(metricValue(data, 'http_reqs', 'count'));
  const failedRate = num(metricValue(data, 'http_req_failed', 'rate'));
  const lagP95 = metricValue(data, 'replay_lag_ms', 'p(95)');
  const dataReceived = num(metricValue(data, 'data_received', 'count'));
  const dropped = num(metricValue(data, 'dropped_iterations', 'count'));
  const iterationAvgMs = num(metricValue(data, 'iteration_duration', 'avg'));
  const behind = (lagP95 !== null && lagP95 > 1000) || dropped > 0 || header.achievedRps < header.targetRps * 0.9;
  const suggestedVus =
    behind && header.targetRps > 0 && iterationAvgMs > 0 ? Math.ceil((header.targetRps * iterationAvgMs * 1.5) / 1000) : null;
  return {
    count,
    failedRate,
    // k6 Rate metrics count `passes` as non-zero samples: for http_req_failed a "pass" IS a failed request.
    failed: metricValue(data, 'http_req_failed', 'passes') ?? Math.round(failedRate * count),
    mismatches: num(metricValue(data, 'replay_status_mismatch', 'count')),
    duration: percentiles(data, 'http_req_duration') ?? EMPTY,
    ttfb: percentiles(data, 'http_req_waiting') ?? EMPTY,
    connectingAvg: num(metricValue(data, 'http_req_connecting', 'avg')),
    tlsAvg: num(metricValue(data, 'http_req_tls_handshaking', 'avg')),
    dataReceived,
    dataSent: num(metricValue(data, 'data_sent', 'count')),
    avgBodyBytes: count > 0 ? dataReceived / count : 0,
    lagP95,
    lagMax: lagP95 === null ? null : metricValue(data, 'replay_lag_ms', 'max'),
    dropped,
    suggestedVus,
  };
}

function buildComponents(data: K6SummaryData, schema: DebugSchema | null): ComponentRow[] {
  if (!schema) return [];
  const rows = new Map<string, ComponentRow>();
  const empty = (path: string): ComponentRow => ({ path, time: null, num: null, usage: null, peak: null });
  for (const entry of schema.entries) {
    const metric = data.metrics[entry.metric];
    if (!metric) continue;
    const row = rows.get(entry.path) ?? empty(entry.path);
    const patch: Partial<ComponentRow> =
      entry.kind === 'time'
        ? { time: percentiles(data, entry.metric) }
        : entry.kind === 'num'
          ? { num: metric.values.count ?? null }
          : entry.kind === 'usage'
            ? { usage: metric.values.avg ?? null }
            : { peak: metric.values.max ?? null };
    rows.set(entry.path, { ...row, ...patch });
  }
  const p95 = (r: ComponentRow): number => r.time?.p95 ?? 0;
  return [...rows.values()].sort((a, b) => p95(b) - p95(a) || num(b.num) - num(a.num) || a.path.localeCompare(b.path));
}

function buildEndpoints(data: K6SummaryData, testDurationMs: number): EndpointRow[] {
  const endpoints = new Set<string>();
  for (const name of Object.keys(data.metrics)) {
    const match = SUBMETRIC_RE.exec(name);
    if (match && match[1] === 'http_reqs' && match[2] !== undefined) endpoints.add(match[2]);
  }
  return [...endpoints]
    .map((endpoint): EndpointRow => {
      const sub = (metric: string, key: string): number => num(metricValue(data, `${metric}{endpoint:${endpoint}}`, key));
      const count = sub('http_reqs', 'count');
      return {
        endpoint,
        count,
        rps: testDurationMs > 0 ? (count * 1000) / testDurationMs : 0,
        failedRate: sub('http_req_failed', 'rate'),
        mismatches: sub('replay_status_mismatch', 'count'),
        duration: percentiles(data, `http_req_duration{endpoint:${endpoint}}`) ?? EMPTY,
      };
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint));
}

function buildDebug(data: K6SummaryData, schema: DebugSchema | null): DebugSection {
  return {
    enabled: schema !== null,
    missing: num(metricValue(data, 'debug_missing', 'count')),
    unknownPaths: num(metricValue(data, 'debug_unknown_paths', 'count')),
  };
}

/** Builds the report model from k6 summary data. */
export function buildReport(data: K6SummaryData, ctx: ReportContext): Report {
  const header = buildHeader(data, ctx);
  return {
    header,
    http: buildHttp(data, header),
    components: buildComponents(data, ctx.schema),
    endpoints: buildEndpoints(data, header.testDurationMs),
    debug: buildDebug(data, ctx.schema),
  };
}

// ---------------------------------------------------------------- console --

function pctCells(p: Percentiles | null): string[] {
  if (!p) return PCT_HEADERS.map(() => '-');
  return [fmtMs(p.min), fmtMs(p.avg), fmtMs(p.p50), fmtMs(p.p90), fmtMs(p.p95), fmtMs(p.p99), fmtMs(p.max)];
}

const PCT_HEADERS = ['min', 'avg', 'p50', 'p90', 'p95', 'p99', 'max'];

function renderHeader(h: HeaderSection, colors: boolean): string {
  const c = palette(colors);
  const load =
    h.mode === 'replay'
      ? `ratio x${fmtNum(h.ratio)} (target ${fmtNum(h.targetRps)} rps), max ${h.vus} VUs`
      : `${fmtNum(h.rps)} rps for ${h.duration}, ${h.vus} VUs (max ${h.maxVus})`;
  const malformed = h.malformed > 0 ? c.yellow(`, ${h.malformed} malformed lines skipped`) : '';
  return [
    c.bold(c.cyan(`nginx-logs-replay  mode=${h.mode}  target=${h.prefix}`)),
    `${c.dim('run:')}       ${h.startedAt} → ${h.finishedAt} (${fmtDuration(h.testDurationMs)})`,
    `${c.dim('pool:')}      ${h.poolKept} of ${h.poolTotal} log entries${malformed}`,
    `${c.dim('original:')}  ${h.logFrom} → ${h.logTo}, ${fmtDuration(h.spanMs)} span, ${fmtNum(h.originalRps)} rps`,
    `${c.dim('load:')}      ${load}`,
    `${c.dim('achieved:')}  ${h.requests} requests, ${fmtNum(h.achievedRps)} rps`,
  ].join('\n');
}

function renderHttp(s: HttpSection, colors: boolean): string {
  const c = palette(colors);
  const failed = s.failedRate > 0 ? c.red(`${s.failed} (${fmtPct(s.failedRate)})`) : c.green(fmtPct(s.failedRate));
  const mismatch = s.mismatches > 0 ? c.yellow(String(s.mismatches)) : String(s.mismatches);
  const lines = [
    c.bold('HTTP'),
    `requests ${s.count}   failed (5xx/transport) ${failed}   status != log ${mismatch}   received ${fmtBytes(s.dataReceived)} (avg ${fmtBytes(s.avgBodyBytes)}/resp)   sent ${fmtBytes(s.dataSent)}`,
    table(['', ...PCT_HEADERS], [['duration', ...pctCells(s.duration)], ['ttfb', ...pctCells(s.ttfb)]]),
    c.dim(`connecting avg ${fmtMs(s.connectingAvg)}  tls avg ${fmtMs(s.tlsAvg)}`),
  ];
  if (s.lagP95 !== null) {
    const lag = `schedule lag p95 ${fmtMs(s.lagP95)}  max ${fmtMs(s.lagMax)}`;
    lines.push(num(s.lagP95) > 1000 ? c.yellow(lag) : c.dim(lag));
  }
  const capacity = capacityWarning(s);
  if (capacity) lines.push(c.yellow(capacity));
  return lines.join('\n');
}

/** One-line diagnosis when the load generator, not the target, was the bottleneck. */
export function capacityWarning(s: HttpSection): string | null {
  const parts: string[] = [];
  if (s.dropped > 0) parts.push(`${s.dropped} requests were never sent (run hit its max duration)`);
  if (s.lagP95 !== null && s.lagP95 > 1000) parts.push('requests fired late');
  if (parts.length === 0 && s.suggestedVus === null) return null;
  const advice = s.suggestedVus !== null ? `the client could not keep up: set VUS to about ${s.suggestedVus} or lower the rate` : 'the client could not keep up: raise VUS or lower the rate';
  return `${parts.length > 0 ? `${parts.join(', ')}; ` : ''}${advice}`;
}

function renderComponents(rows: readonly ComponentRow[], debug: DebugSection, colors: boolean): string {
  const c = palette(colors);
  if (!debug.enabled) return `${c.bold('COMPONENTS')}\n${c.dim('no debug schema: run discover.ts first to get per-component metrics')}`;
  if (rows.length === 0) return `${c.bold('COMPONENTS')}\n${c.dim('no debug samples recorded')}`;
  const body = table(
    ['component', ...PCT_HEADERS, 'num', 'mem avg', 'mem peak'],
    rows.map((r) => [r.path, ...pctCells(r.time), fmtNum(r.num), fmtNum(r.usage), fmtNum(r.peak)]),
  );
  const notes: string[] = [];
  if (debug.missing > 0) notes.push(c.yellow(`${debug.missing} responses without a debug block`));
  if (debug.unknownPaths > 0) notes.push(c.yellow(`${debug.unknownPaths} samples on paths missing from the schema (re-run discover.ts)`));
  return [`${c.bold('COMPONENTS')} ${c.dim('(sorted by p95, time from the debug block)')}`, body, ...notes].join('\n');
}

function renderEndpoints(rows: readonly EndpointRow[], top: number, colors: boolean): string {
  const c = palette(colors);
  if (rows.length === 0) return '';
  const body = table(
    ['endpoint', 'count', 'rps', 'failed', '!=log', ...PCT_HEADERS],
    rows.map((r) => [
      r.endpoint,
      String(r.count),
      fmtNum(r.rps),
      r.failedRate > 0 ? c.red(fmtPct(r.failedRate)) : fmtPct(r.failedRate),
      r.mismatches > 0 ? c.yellow(String(r.mismatches)) : String(r.mismatches),
      ...pctCells(r.duration),
    ]),
  );
  return [`${c.bold('ENDPOINTS')} ${c.dim(`(top ${top} by count)`)}`, body].join('\n');
}

/** Renders the report as console text. */
export function renderReport(report: Report, top: number, colors: boolean): string {
  const sections = [
    renderHeader(report.header, colors),
    renderHttp(report.http, colors),
    renderComponents(report.components, report.debug, colors),
    renderEndpoints(report.endpoints, top, colors),
  ].filter((section) => section !== '');
  return `\n${sections.join('\n\n')}\n\n`;
}
