/**
 * Turns k6's end-of-test summary data into a report model and renders it as
 * console text. The same model feeds html-report.ts. Pure.
 */

import { analyzeCapacity, recommendRatio, recommendRps, type LoadRow } from './capacity.ts';
import type { Config } from './config.ts';
import type { DebugSchema } from './debug-walker.ts';
import { fmtBytes, fmtDuration, fmtMs, fmtNum, fmtPct, palette, table } from './format.ts';
import type { PoolStats } from './request-pool.ts';
import type { VuAllocation } from './schedule.ts';

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
  /** VU allocation (preAllocatedVUs = VUs the scenario actually ran with). */
  readonly vus: VuAllocation;
  /** Wall-clock rps the plan aims at: busiest second for replay, RPS for rate. */
  readonly targetRps: number;
  /** Planned wall-clock length of a replay (null for rate mode). */
  readonly plannedMs: number | null;
  /** Average request duration measured by discover probes (ms), if known. */
  readonly probeAvgMs?: number | null;
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
  readonly plannedMs: number | null;
  readonly vus: number;
  readonly maxVus: number;
  readonly vusAuto: boolean;
  readonly assumedLatencyMs: number;
  readonly probeAvgMs: number | null;
  readonly requests: number;
}

export interface MismatchPair {
  /** Status code in the log. */
  readonly from: number;
  /** Status code (bucket) received on replay. */
  readonly to: number;
  readonly count: number;
}

export interface HttpSection {
  readonly count: number;
  readonly failedRate: number;
  readonly failed: number;
  readonly mismatches: number;
  /** Mismatches by (log status -> replayed status), descending. */
  readonly mismatchPairs: readonly MismatchPair[];
  readonly duration: Percentiles;
  /** Time to first byte (http_req_waiting). */
  readonly ttfb: Percentiles;
  readonly connectingAvg: number;
  readonly tlsAvg: number;
  readonly dataReceived: number;
  readonly dataSent: number;
  readonly avgBodyBytes: number;
  readonly lagP50: number | null;
  readonly lagP90: number | null;
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

export interface CapacitySection {
  /** Latency by offered load, ascending. */
  readonly rows: readonly LoadRow[];
  readonly referenceP95: number | null;
  readonly healthyUpToRps: number | null;
  readonly degradedFromRps: number | null;
  readonly verdict: string;
  /** RATIO for the next replay, when one can be recommended. */
  readonly nextRatio: number | null;
  /** Highest RATIO without degradation seen in this run. */
  readonly safeRatio: number | null;
}

export interface Report {
  readonly header: HeaderSection;
  readonly http: HttpSection;
  readonly capacity: CapacitySection;
  readonly components: readonly ComponentRow[];
  readonly endpoints: readonly EndpointRow[];
  readonly debug: DebugSection;
}

const SUBMETRIC_RE = /^([a-zA-Z0-9_]+)\{endpoint:(.*)\}$/;
const MISMATCH_PAIR_RE = /^replay_status_mismatch\{from:(\d+),to:(\d+)\}$/;

function mismatchPairs(data: K6SummaryData): MismatchPair[] {
  const pairs: MismatchPair[] = [];
  for (const [name, metric] of Object.entries(data.metrics)) {
    const match = MISMATCH_PAIR_RE.exec(name);
    const count = metric.values.count ?? 0;
    if (match && count > 0) pairs.push({ from: Number(match[1]), to: Number(match[2]), count });
  }
  return pairs.sort((a, b) => b.count - a.count || a.from - b.from || a.to - b.to);
}

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
    targetRps: ctx.targetRps,
    achievedRps: num(metricValue(data, 'http_reqs', 'rate')),
    ratio: ctx.config.ratio,
    rps: ctx.config.rps,
    duration: ctx.config.duration,
    plannedMs: ctx.plannedMs,
    vus: ctx.vus.preAllocatedVUs,
    maxVus: ctx.vus.maxVUs,
    vusAuto: ctx.vus.auto,
    assumedLatencyMs: ctx.vus.assumedLatencyMs,
    probeAvgMs: ctx.probeAvgMs ?? null,
    requests: num(metricValue(data, 'http_reqs', 'count')),
  };
}

function buildHttp(data: K6SummaryData, header: HeaderSection): HttpSection {
  const count = num(metricValue(data, 'http_reqs', 'count'));
  const failedRate = num(metricValue(data, 'http_req_failed', 'rate'));
  const lagP95 = metricValue(data, 'replay_lag_ms', 'p(95)');
  const dataReceived = num(metricValue(data, 'data_received', 'count'));
  const dropped = num(metricValue(data, 'dropped_iterations', 'count'));
  // Sizing latency: what a VU is busy for during the bad moments (p95), never below twice the average.
  const duration = percentiles(data, 'http_req_duration') ?? EMPTY;
  const sizingLatencyMs = Math.max(duration.avg * 2, duration.p95);
  // Replay: compare with the average rate of the plan; rate mode: with the configured rps.
  const expectedRps = header.plannedMs && header.plannedMs > 0 ? (header.poolKept * 1000) / header.plannedMs : header.targetRps;
  const behind = (lagP95 !== null && lagP95 > 1000) || dropped > 0 || (expectedRps > 0 && header.achievedRps < expectedRps * 0.9);
  const suggestedVus =
    behind && header.targetRps > 0 && sizingLatencyMs > 0 ? Math.ceil((header.targetRps * sizingLatencyMs * 1.2) / 1000) : null;
  return {
    count,
    failedRate,
    // k6 Rate metrics count `passes` as non-zero samples: for http_req_failed a "pass" IS a failed request.
    failed: metricValue(data, 'http_req_failed', 'passes') ?? Math.round(failedRate * count),
    mismatches: num(metricValue(data, 'replay_status_mismatch', 'count')),
    mismatchPairs: mismatchPairs(data),
    duration: percentiles(data, 'http_req_duration') ?? EMPTY,
    ttfb: percentiles(data, 'http_req_waiting') ?? EMPTY,
    connectingAvg: num(metricValue(data, 'http_req_connecting', 'avg')),
    tlsAvg: num(metricValue(data, 'http_req_tls_handshaking', 'avg')),
    dataReceived,
    dataSent: num(metricValue(data, 'data_sent', 'count')),
    avgBodyBytes: count > 0 ? dataReceived / count : 0,
    lagP50: lagP95 === null ? null : metricValue(data, 'replay_lag_ms', 'med'),
    lagP90: lagP95 === null ? null : metricValue(data, 'replay_lag_ms', 'p(90)'),
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

const LOAD_RE = /^http_reqs\{load:(\d+)\}$/;

function loadRows(data: K6SummaryData): LoadRow[] {
  const rows: LoadRow[] = [];
  for (const name of Object.keys(data.metrics)) {
    const match = LOAD_RE.exec(name);
    if (!match) continue;
    const edge = Number(match[1]);
    const count = num(metricValue(data, name, 'count'));
    if (count === 0) continue;
    rows.push({
      upToRps: edge,
      count,
      failedRate: num(metricValue(data, `http_req_failed{load:${edge}}`, 'rate')),
      duration: percentiles(data, `http_req_duration{load:${edge}}`) ?? EMPTY,
    });
  }
  return rows.sort((a, b) => a.upToRps - b.upToRps);
}

function buildCapacity(data: K6SummaryData, header: HeaderSection): CapacitySection {
  const analysis = analyzeCapacity(loadRows(data));
  const recommendation =
    header.mode === 'replay'
      ? recommendRatio(analysis, header.ratio, header.ratio > 0 ? header.targetRps / header.ratio : 0)
      : recommendRps(analysis.rows[0], header.rps, header.probeAvgMs);
  return {
    rows: analysis.rows,
    referenceP95: analysis.referenceP95,
    healthyUpToRps: analysis.healthyUpToRps,
    degradedFromRps: analysis.degradedFromRps,
    verdict: recommendation.verdict,
    nextRatio: recommendation.nextRatio,
    safeRatio: recommendation.safeRatio,
  };
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
    capacity: buildCapacity(data, header),
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
  const vus = h.vusAuto ? `auto VUs ${h.vus} (assumed ${h.assumedLatencyMs}ms latency)` : `fixed VUs ${h.vus}`;
  const load =
    h.mode === 'replay'
      ? `ratio x${fmtNum(h.ratio)} (planned ${fmtDuration(h.plannedMs ?? 0)}, busiest second ${fmtNum(h.targetRps)} rps), ${vus}`
      : `${fmtNum(h.rps)} rps for ${h.duration}, ${vus}, up to ${h.maxVus}`;
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

function renderHttp(s: HttpSection, colors: boolean, capacity: string | null): string {
  const c = palette(colors);
  const failed = s.failedRate > 0 ? c.red(`${s.failed} (${fmtPct(s.failedRate)})`) : c.green(fmtPct(s.failedRate));
  const mismatch = s.mismatches > 0 ? c.yellow(String(s.mismatches)) : String(s.mismatches);
  const pairs = s.mismatchPairs.slice(0, 8).map((p) => `${p.from}→${p.to} ×${p.count}`).join(', ');
  const lines = [
    c.bold('HTTP'),
    `requests ${s.count}   failed (5xx/transport) ${failed}   status != log ${mismatch}   received ${fmtBytes(s.dataReceived)} (avg ${fmtBytes(s.avgBodyBytes)}/resp)   sent ${fmtBytes(s.dataSent)}`,
    table(['', ...PCT_HEADERS], [['duration', ...pctCells(s.duration)], ['ttfb', ...pctCells(s.ttfb)]]),
    c.dim(`connecting avg ${fmtMs(s.connectingAvg)}  tls avg ${fmtMs(s.tlsAvg)}`),
  ];
  if (pairs) lines.push(c.yellow(`status != log by pair (log→replay): ${pairs}${s.mismatchPairs.length > 8 ? ', …' : ''}`));
  if (s.lagP95 !== null) {
    const lag = `schedule lag p95 ${fmtMs(s.lagP95)}  max ${fmtMs(s.lagMax)}`;
    lines.push(num(s.lagP95) > 1000 ? c.yellow(lag) : c.dim(lag));
  }
  if (capacity) lines.push(c.yellow(capacity));
  return lines.join('\n');
}

/**
 * Diagnosis when the schedule was not kept: what happened (late / dropped
 * requests), why (slow target vs slow generator) and what to do about it.
 */
export function capacityWarning(report: Report): string | null {
  const s = report.http;
  const h = report.header;
  const late = s.lagP95 !== null && s.lagP95 > 1000;
  if (!late && s.dropped === 0 && s.suggestedVus === null) return null;
  const facts: string[] = [];
  if (late) {
    const mostlyKept = (s.lagP50 ?? 0) < 100;
    facts.push(
      mostlyKept
        ? `Timeline kept for most requests (p50 lag ${fmtMs(s.lagP50)}) but a tail fired late: p90 ${fmtMs(s.lagP90)}, p95 ${fmtMs(s.lagP95)}, max ${fmtMs(s.lagMax)}, because all ${h.vus} VUs were busy during bursts`
        : `Timeline not kept: requests fired late by p50 ${fmtMs(s.lagP50)}, p95 ${fmtMs(s.lagP95)}, max ${fmtMs(s.lagMax)} because all ${h.vus} VUs were busy`,
    );
  }
  if (s.dropped > 0) facts.push(`${s.dropped} requests were never sent (no free VU / max duration reached)`);
  if (facts.length === 0) facts.push('Achieved rps stayed below the plan');
  const reference = h.probeAvgMs ?? h.assumedLatencyMs;
  const referenceLabel = h.probeAvgMs !== null ? 'during discover' : 'assumed';
  const cause =
    s.duration.p95 > reference * 3
      ? `Responses were slow under load (p95 ${fmtMs(s.duration.p95)}, max ${fmtMs(s.duration.max)} vs ${fmtMs(reference)} ${referenceLabel}): the target saturated, which is a real finding, and the applied load was softer than planned`
      : `Responses stayed fast (p95 ${fmtMs(s.duration.p95)}), so the load generator itself was the limit (agent CPU or too few VUs)`;
  const advice =
    s.suggestedVus !== null
      ? `To force the exact timeline at these latencies set VUS to about ${s.suggestedVus}; otherwise lower RATIO/RPS`
      : 'Raise VUS or lower RATIO/RPS';
  return `${facts.join('. ')}. ${cause}. ${advice}.`;
}

function renderCapacity(cap: CapacitySection, colors: boolean): string {
  const c = palette(colors);
  const title = `${c.bold('LOAD vs LATENCY')} ${c.dim('(offered rps in the request\'s second → latency)')}`;
  if (cap.rows.length === 0) return `${title}\n${c.dim(cap.verdict)}`;
  const body = table(
    ['up to rps', 'requests', 'failed', 'p50', 'p95', 'p99', 'max', ''],
    cap.rows.map((r) => [
      String(r.upToRps),
      String(r.count),
      fmtPct(r.failedRate),
      fmtMs(r.duration.p50),
      fmtMs(r.duration.p95),
      fmtMs(r.duration.p99),
      fmtMs(r.duration.max),
      cap.degradedFromRps !== null && r.upToRps >= cap.degradedFromRps ? c.red('degraded') : c.green('ok'),
    ]),
    ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
  );
  const verdict = cap.degradedFromRps === null ? c.green(cap.verdict) : c.yellow(cap.verdict);
  return [title, body, verdict].join('\n');
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
    renderHttp(report.http, colors, capacityWarning(report)),
    renderCapacity(report.capacity, colors),
    renderComponents(report.components, report.debug, colors),
    renderEndpoints(report.endpoints, top, colors),
  ].filter((section) => section !== '');
  return `\n${sections.join('\n\n')}\n\n`;
}
