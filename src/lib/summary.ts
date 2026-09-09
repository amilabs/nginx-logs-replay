/**
 * Turns k6's end-of-test summary data into a report model and renders it.
 * Pure: the k6 data shape is described locally, no k6 imports.
 */

import type { Config } from './config.ts';
import type { DebugSchema } from './debug-walker.ts';
import { fmtDuration, fmtMs, fmtNum, fmtPct, palette, table } from './format.ts';
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
}

export interface HeaderSection {
  readonly mode: string;
  readonly prefix: string;
  readonly poolTotal: number;
  readonly poolKept: number;
  readonly malformed: number;
  readonly spanMs: number;
  readonly originalRps: number;
  readonly ratio: number;
  readonly rps: number;
  readonly vus: number;
  readonly testDurationMs: number;
  readonly requests: number;
  readonly achievedRps: number;
}

export interface HttpSection {
  readonly count: number;
  readonly failedRate: number;
  readonly mismatches: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly lagP95: number | null;
  readonly lagMax: number | null;
}

export interface ComponentRow {
  readonly path: string;
  readonly avg: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly num: number | null;
  readonly usage: number | null;
  readonly peak: number | null;
}

export interface EndpointRow {
  readonly endpoint: string;
  readonly count: number;
  readonly failedRate: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
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

function buildHeader(data: K6SummaryData, ctx: ReportContext): HeaderSection {
  return {
    mode: ctx.config.mode,
    prefix: ctx.config.prefix,
    poolTotal: ctx.pool.total,
    poolKept: ctx.pool.kept,
    malformed: ctx.malformed,
    spanMs: ctx.pool.spanMs,
    originalRps: ctx.pool.originalRps,
    ratio: ctx.config.ratio,
    rps: ctx.config.rps,
    vus: ctx.vus ?? ctx.config.vus,
    testDurationMs: data.state?.testRunDurationMs ?? 0,
    requests: num(metricValue(data, 'http_reqs', 'count')),
    achievedRps: num(metricValue(data, 'http_reqs', 'rate')),
  };
}

function buildHttp(data: K6SummaryData): HttpSection {
  const lagP95 = metricValue(data, 'replay_lag_ms', 'p(95)');
  return {
    count: num(metricValue(data, 'http_reqs', 'count')),
    failedRate: num(metricValue(data, 'http_req_failed', 'rate')),
    mismatches: num(metricValue(data, 'replay_status_mismatch', 'count')),
    avg: num(metricValue(data, 'http_req_duration', 'avg')),
    p50: num(metricValue(data, 'http_req_duration', 'med')),
    p95: num(metricValue(data, 'http_req_duration', 'p(95)')),
    p99: num(metricValue(data, 'http_req_duration', 'p(99)')),
    max: num(metricValue(data, 'http_req_duration', 'max')),
    lagP95,
    lagMax: lagP95 === null ? null : metricValue(data, 'replay_lag_ms', 'max'),
  };
}

function buildComponents(data: K6SummaryData, schema: DebugSchema | null): ComponentRow[] {
  if (!schema) return [];
  const rows = new Map<string, ComponentRow>();
  const empty = (path: string): ComponentRow => ({ path, avg: null, p95: null, p99: null, max: null, num: null, usage: null, peak: null });
  for (const entry of schema.entries) {
    const metric = data.metrics[entry.metric];
    if (!metric) continue;
    const row = rows.get(entry.path) ?? empty(entry.path);
    const patch: Partial<ComponentRow> =
      entry.kind === 'time'
        ? { avg: metric.values.avg ?? null, p95: metric.values['p(95)'] ?? null, p99: metric.values['p(99)'] ?? null, max: metric.values.max ?? null }
        : entry.kind === 'num'
          ? { num: metric.values.count ?? null }
          : entry.kind === 'usage'
            ? { usage: metric.values.avg ?? null }
            : { peak: metric.values.max ?? null };
    rows.set(entry.path, { ...row, ...patch });
  }
  return [...rows.values()].sort((a, b) => num(b.p95) - num(a.p95) || num(b.num) - num(a.num) || a.path.localeCompare(b.path));
}

function buildEndpoints(data: K6SummaryData): EndpointRow[] {
  const endpoints = new Set<string>();
  for (const name of Object.keys(data.metrics)) {
    const match = SUBMETRIC_RE.exec(name);
    if (match && match[1] === 'http_reqs' && match[2] !== undefined) endpoints.add(match[2]);
  }
  return [...endpoints]
    .map((endpoint): EndpointRow => {
      const sub = (metric: string, key: string): number => num(metricValue(data, `${metric}{endpoint:${endpoint}}`, key));
      return {
        endpoint,
        count: sub('http_reqs', 'count'),
        failedRate: sub('http_req_failed', 'rate'),
        p50: sub('http_req_duration', 'med'),
        p95: sub('http_req_duration', 'p(95)'),
        max: sub('http_req_duration', 'max'),
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
  return {
    header: buildHeader(data, ctx),
    http: buildHttp(data),
    components: buildComponents(data, ctx.schema),
    endpoints: buildEndpoints(data),
    debug: buildDebug(data, ctx.schema),
  };
}

function renderHeader(h: HeaderSection, colors: boolean): string {
  const c = palette(colors);
  const load =
    h.mode === 'replay'
      ? `ratio x${fmtNum(h.ratio)} (target ${fmtNum(h.originalRps * h.ratio)} rps), max ${h.vus} VUs`
      : `${fmtNum(h.rps)} rps, ${h.vus} VUs`;
  const malformed = h.malformed > 0 ? c.yellow(`, ${h.malformed} malformed lines skipped`) : '';
  return [
    c.bold(c.cyan(`nginx-logs-replay  mode=${h.mode}  target=${h.prefix}`)),
    `${c.dim('pool:')}      ${h.poolKept} of ${h.poolTotal} log entries${malformed}`,
    `${c.dim('original:')}  ${fmtDuration(h.spanMs)} span, ${fmtNum(h.originalRps)} rps`,
    `${c.dim('load:')}      ${load}`,
    `${c.dim('achieved:')}  ${h.requests} requests in ${fmtDuration(h.testDurationMs)}, ${fmtNum(h.achievedRps)} rps`,
  ].join('\n');
}

function renderHttp(s: HttpSection, colors: boolean): string {
  const c = palette(colors);
  const failed = s.failedRate > 0 ? c.red(fmtPct(s.failedRate)) : c.green(fmtPct(s.failedRate));
  const mismatch = s.mismatches > 0 ? c.yellow(String(s.mismatches)) : String(s.mismatches);
  const lines = [
    c.bold('HTTP'),
    `requests ${s.count}   failed (5xx/transport) ${failed}   status != log ${mismatch}`,
    `duration avg ${fmtMs(s.avg)}  p50 ${fmtMs(s.p50)}  p95 ${fmtMs(s.p95)}  p99 ${fmtMs(s.p99)}  max ${fmtMs(s.max)}`,
  ];
  if (s.lagP95 !== null) {
    const lag = `schedule lag p95 ${fmtMs(s.lagP95)}  max ${fmtMs(s.lagMax)}`;
    lines.push(num(s.lagP95) > 1000 ? c.yellow(`${lag}  (client could not keep up: raise VUS or lower RATIO)`) : c.dim(lag));
  }
  return lines.join('\n');
}

function renderComponents(rows: readonly ComponentRow[], debug: DebugSection, colors: boolean): string {
  const c = palette(colors);
  if (!debug.enabled) return `${c.bold('COMPONENTS')}\n${c.dim('no debug schema: run discover.ts first to get per-component metrics')}`;
  if (rows.length === 0) return `${c.bold('COMPONENTS')}\n${c.dim('no debug samples recorded')}`;
  const body = table(
    ['component', 'avg', 'p95', 'p99', 'max', 'num', 'mem avg', 'mem peak'],
    rows.map((r) => [r.path, fmtMs(r.avg), fmtMs(r.p95), fmtMs(r.p99), fmtMs(r.max), fmtNum(r.num), fmtNum(r.usage), fmtNum(r.peak)]),
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
    ['endpoint', 'count', 'failed', 'p50', 'p95', 'max'],
    rows.map((r) => [r.endpoint, String(r.count), r.failedRate > 0 ? c.red(fmtPct(r.failedRate)) : fmtPct(r.failedRate), fmtMs(r.p50), fmtMs(r.p95), fmtMs(r.max)]),
  );
  return [`${c.bold(`ENDPOINTS`)} ${c.dim(`(top ${top} by count)`)}`, body].join('\n');
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
