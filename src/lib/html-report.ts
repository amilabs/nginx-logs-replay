/**
 * Self-contained HTML report (inline CSS + SVG, no JavaScript) built from the
 * same Report model as the console summary. Pure.
 */

import { fmtBytes, fmtDuration, fmtMs, fmtNum, fmtPct } from './format.ts';
import { barChart, escapeHtml, type BarRow } from './html-charts.ts';
import { capacityWarning, type CapacitySection, type ComponentRow, type EndpointRow, type HeaderSection, type HttpSection, type Percentiles, type Report } from './summary.ts';

export interface HtmlReportOptions {
  readonly title?: string;
  /** Relative link to the k6 web-dashboard export (time series), if produced. */
  readonly dashboardHref?: string;
  readonly generatedAt?: string;
}

const CSS = `
:root { color-scheme: light; }
body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #111827; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 10px; }
h2 small { font-weight: normal; color: #6b7280; font-size: 13px; }
.sub { color: #6b7280; margin-bottom: 18px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
.card .k { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
.card .v { font-size: 20px; font-weight: 600; margin-top: 2px; }
.card .d { color: #6b7280; font-size: 12px; }
.bad { color: #dc2626; }
.warn { color: #d97706; }
.ok { color: #16a34a; }
table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
th, td { padding: 6px 10px; text-align: right; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
th { background: #f9fafb; color: #374151; font-weight: 600; }
tr:last-child td { border-bottom: 0; }
table.kv td:first-child { font-family: inherit; color: #6b7280; width: 220px; }
table.kv td { text-align: left; }
.chart { display: block; margin: 8px 0 4px; }
.chart .lbl { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #374151; }
.chart .val { font: 12px -apple-system, sans-serif; fill: #111827; }
.legend { color: #6b7280; font-size: 12px; margin-bottom: 4px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: -1px; }
.note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.verdict { border-radius: 8px; padding: 12px 14px; margin: 8px 0 16px; font-size: 15px; }
.verdict.good { background: #ecfdf5; border: 1px solid #a7f3d0; }
.verdict.knee { background: #eff6ff; border: 1px solid #bfdbfe; }
.verdict b { display: block; margin-bottom: 4px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
footer { color: #9ca3af; font-size: 12px; margin-top: 28px; }
`;

const PCT_HEADERS = ['min', 'avg', 'p50', 'p75', 'p90', 'p95', 'p99', 'p99.9', 'max'];

function pctCells(p: Percentiles | null): string {
  if (!p) return PCT_HEADERS.map(() => '<td>-</td>').join('');
  return [p.min, p.avg, p.p50, p.p75, p.p90, p.p95, p.p99, p.p999, p.max].map((v) => `<td>${fmtMs(v)}</td>`).join('');
}

function pctHeaderCells(): string {
  return PCT_HEADERS.map((h) => `<th>${h}</th>`).join('');
}

function card(label: string, value: string, detail = '', cls = ''): string {
  return `<div class="card"><div class="k">${escapeHtml(label)}</div><div class="v ${cls}">${value}</div><div class="d">${detail}</div></div>`;
}

function renderCards(h: HeaderSection, s: HttpSection, warning: string | null): string {
  const vus = h.vusAuto ? `auto VUs ${h.vus}` : `fixed VUs ${h.vus}`;
  const load =
    h.mode === 'replay'
      ? card('Load', `x${fmtNum(h.ratio)}`, `planned ${fmtDuration(h.plannedMs ?? 0)}, ${vus}`)
      : card('Load', `${fmtNum(h.rps)} rps`, `for ${escapeHtml(h.duration)}, ${vus} → ${h.maxVus}`);
  const expectedRps = h.mode === 'replay' ? h.originalRps * h.ratio : h.targetRps;
  const rpsCls = expectedRps > 0 && h.achievedRps < expectedRps * 0.9 ? 'warn' : '';
  const lag =
    s.lagP95 === null
      ? ''
      : card('Schedule lag p95', fmtMs(s.lagP95), `max ${fmtMs(s.lagMax)}`, (s.lagP95 ?? 0) > 1000 ? 'warn' : '');
  return `<div class="cards">
${card('Requests', String(h.requests), `in ${fmtDuration(h.testDurationMs)}`)}
${card('Achieved RPS', fmtNum(h.achievedRps), h.mode === 'replay' ? `original ${fmtNum(h.originalRps)} · x${fmtNum(h.ratio)} = ${fmtNum(h.originalRps * h.ratio)} avg, ${fmtNum(h.targetRps)} peak` : `target ${fmtNum(h.targetRps)}`, rpsCls)}
${load}
${card('Failed', fmtPct(s.failedRate), `${s.failed} × 5xx / transport`, s.failedRate > 0 ? 'bad' : 'ok')}
${card('Status ≠ log', String(s.mismatches), s.mismatchPairs.length > 0 ? s.mismatchPairs.slice(0, 3).map((p) => `${p.from}→${p.to} ×${p.count}`).join(', ') : 'replayed status differs from the log', s.mismatches > 0 ? 'warn' : '')}
${card('p50', fmtMs(s.duration.p50), `avg ${fmtMs(s.duration.avg)}`)}
${card('p95', fmtMs(s.duration.p95), `p99 ${fmtMs(s.duration.p99)}`)}
${card('max', fmtMs(s.duration.max), `min ${fmtMs(s.duration.min)}`)}
${lag}
${s.dropped > 0 ? card('Not sent', String(s.dropped), 'no free VU / max duration', 'bad') : ''}
</div>
${warning ? `<div class="note">${escapeHtml(warning)}</div>` : ''}`;
}

function renderMismatches(s: HttpSection): string {
  if (s.mismatchPairs.length === 0) return '';
  const rows = s.mismatchPairs
    .map((p) => `<tr><td>${p.from} → ${p.to}</td><td>${p.count}</td><td>${fmtPct(s.mismatches > 0 ? p.count / s.mismatches : 0)}</td></tr>`)
    .join('\n');
  return `<h2>Status ≠ log <small>(status in the log → status received on replay; 429/406 in the log usually mean the production rate limiter rejected the request, so replaying it puts more load on the backend than production saw — use SKIP_STATUSES=429,5xx to replay only what production served)</small></h2>
<table><thead><tr><th>log → replay</th><th>count</th><th>share</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

function renderRun(h: HeaderSection, s: HttpSection): string {
  const kv = (k: string, v: string): string => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`;
  const malformed = h.malformed > 0 ? ` <span class="warn">(${h.malformed} malformed lines skipped)</span>` : '';
  const run = [
    kv('Target', escapeHtml(h.prefix)),
    kv('Mode', h.mode === 'replay' ? `replay, ratio x${fmtNum(h.ratio)}${h.plannedMs ? ` (planned ${fmtDuration(h.plannedMs)})` : ''}` : `rate, ${fmtNum(h.rps)} rps for ${escapeHtml(h.duration)}`),
    kv('Started', escapeHtml(h.startedAt)),
    kv('Finished', escapeHtml(h.finishedAt)),
    kv('Duration', fmtDuration(h.testDurationMs)),
    kv('VUs', h.vusAuto ? `${h.vus}, automatic (busiest second × ${h.assumedLatencyMs}ms assumed latency × 2)${h.mode === 'rate' ? `, up to ${h.maxVus}` : ''}` : `${h.vus}, fixed${h.mode === 'rate' ? `, up to ${h.maxVus}` : ''}`),
    kv('Requests sent', String(h.requests)),
    kv('Achieved RPS', fmtNum(h.achievedRps)),
    kv(h.mode === 'replay' ? 'Busiest second' : 'Target RPS', `${fmtNum(h.targetRps)} rps`),
  ].join('\n');
  const log = [
    kv('Log entries', `${h.poolKept} replayed of ${h.poolTotal}${malformed}`),
    kv('Log window', `${escapeHtml(h.logFrom)} → ${escapeHtml(h.logTo)}`),
    kv('Log span', fmtDuration(h.spanMs)),
    kv('Original RPS', fmtNum(h.originalRps)),
    kv('Data received', `${fmtBytes(s.dataReceived)} (avg ${fmtBytes(s.avgBodyBytes)} per response)`),
    kv('Data sent', fmtBytes(s.dataSent)),
    kv('Connecting avg', fmtMs(s.connectingAvg)),
    kv('TLS handshake avg', fmtMs(s.tlsAvg)),
  ].join('\n');
  return `<h2>Run</h2>
<div class="two">
<table class="kv"><tbody>${run}</tbody></table>
<table class="kv"><tbody>${log}</tbody></table>
</div>`;
}

function renderLatency(s: HttpSection): string {
  const rows: BarRow[] = [
    { label: 'p50', value: s.duration.p50, overlay: s.ttfb.p50, text: `${fmtMs(s.duration.p50)} · ttfb ${fmtMs(s.ttfb.p50)}` },
    { label: 'p75', value: s.duration.p75, overlay: s.ttfb.p75, text: `${fmtMs(s.duration.p75)} · ttfb ${fmtMs(s.ttfb.p75)}` },
    { label: 'p90', value: s.duration.p90, overlay: s.ttfb.p90, text: `${fmtMs(s.duration.p90)} · ttfb ${fmtMs(s.ttfb.p90)}` },
    { label: 'p95', value: s.duration.p95, overlay: s.ttfb.p95, text: `${fmtMs(s.duration.p95)} · ttfb ${fmtMs(s.ttfb.p95)}` },
    { label: 'p99', value: s.duration.p99, overlay: s.ttfb.p99, text: `${fmtMs(s.duration.p99)} · ttfb ${fmtMs(s.ttfb.p99)}` },
    { label: 'p99.9', value: s.duration.p999, overlay: s.ttfb.p999, text: `${fmtMs(s.duration.p999)} · ttfb ${fmtMs(s.ttfb.p999)}` },
    { label: 'max', value: s.duration.max, overlay: s.ttfb.max, text: `${fmtMs(s.duration.max)} · ttfb ${fmtMs(s.ttfb.max)}` },
  ];
  return `<h2>Latency <small>(http_req_duration; ttfb = http_req_waiting)</small></h2>
<div class="legend"><i style="background:#60a5fa"></i>duration <i style="background:#1d4ed8"></i>ttfb</div>
${barChart(rows, { labelWidth: 80 })}
<table><thead><tr><th></th>${pctHeaderCells()}</tr></thead><tbody>
<tr><td>duration</td>${pctCells(s.duration)}</tr>
<tr><td>ttfb</td>${pctCells(s.ttfb)}</tr>
</tbody></table>`;
}

function renderCapacity(cap: CapacitySection): string {
  const cls = cap.capped ? 'knee' : 'good';
  const headline =
    cap.nextRatio !== null
      ? `Suggested next run: RATIO=${cap.nextRatio}${cap.kneeRatio !== null ? ` · latency starts climbing at ~x${cap.kneeRatio}` : ''}`
      : 'Suggested next run';
  const verdict = `<div class="verdict ${cls}"><b>${escapeHtml(headline)}</b>${escapeHtml(cap.verdict)}</div>`;
  if (cap.rows.length === 0) return `<h2>Load vs latency</h2>${verdict}`;
  const bars: BarRow[] = cap.rows.map((r) => ({
    label: `≤ ${r.upToRps} rps (${r.count} req)`,
    value: r.duration.p95,
    overlay: r.duration.p50,
    text: `p95 ${fmtMs(r.duration.p95)} · p50 ${fmtMs(r.duration.p50)}`,
    alert: cap.degradedFromRps !== null && r.upToRps >= cap.degradedFromRps,
  }));
  const table = cap.rows
    .map(
      (r) =>
        `<tr><td>≤ ${r.upToRps}</td><td>${r.count}</td><td class="${r.failedRate > 0.01 ? 'bad' : ''}">${fmtPct(r.failedRate)}</td>${pctCells(r.duration)}<td class="${cap.degradedFromRps !== null && r.upToRps >= cap.degradedFromRps ? 'bad' : 'ok'}">${cap.degradedFromRps !== null && r.upToRps >= cap.degradedFromRps ? 'climbing' : 'flat'}</td></tr>`,
    )
    .join('\n');
  return `<h2>Load vs latency <small>(offered rps in the second each request was due → its latency; a bucket counts with ≥100 requests and ≥2% of the run; "climbing" = p95 above 2× the low-load p95 + 200ms, or &gt;1% failed)</small></h2>
${verdict}
<div class="legend"><i style="background:#60a5fa"></i>p95 <i style="background:#1d4ed8"></i>p50 <i style="background:#ef4444"></i>latency climbing</div>
${barChart(bars, { labelWidth: 170 })}
<table><thead><tr><th>offered load</th><th>requests</th><th>failed</th>${pctHeaderCells()}<th></th></tr></thead><tbody>
${table}
</tbody></table>`;
}

function renderComponents(report: Report): string {
  const d = report.debug;
  if (!d.enabled) return `<h2>Components</h2><div class="note">No debug schema: run <code>discover.ts</code> first to get per-component metrics.</div>`;
  if (report.components.length === 0) return `<h2>Components</h2><div class="note">No debug samples recorded.</div>`;
  const withTime = report.components.filter((r): r is ComponentRow & { time: Percentiles } => r.time !== null);
  const bars: BarRow[] = withTime.map((r) => ({
    label: r.path,
    value: r.time.p95,
    overlay: r.time.avg,
    text: `p95 ${fmtMs(r.time.p95)} · avg ${fmtMs(r.time.avg)}`,
  }));
  const table = report.components
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.path)}</td>${pctCells(r.time)}<td>${fmtNum(r.num)}</td><td>${fmtNum(r.usage)}</td><td>${fmtNum(r.peak)}</td></tr>`,
    )
    .join('\n');
  const notes: string[] = [];
  if (d.missing > 0) notes.push(`<div class="note">${d.missing} responses without a debug block.</div>`);
  if (d.unknownPaths > 0) notes.push(`<div class="note">${d.unknownPaths} samples on paths missing from the schema — re-run <code>discover.ts</code>.</div>`);
  return `<h2>Components <small>(time from the debug block, sorted by p95)</small></h2>
<div class="legend"><i style="background:#60a5fa"></i>p95 <i style="background:#1d4ed8"></i>avg</div>
${barChart(bars)}
<table><thead><tr><th>component</th>${pctHeaderCells()}<th>num</th><th>mem avg</th><th>mem peak</th></tr></thead><tbody>
${table}
</tbody></table>
${notes.join('\n')}`;
}

function renderEndpoints(rows: readonly EndpointRow[], top: number): string {
  if (rows.length === 0) return '';
  const table = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.endpoint)}</td><td>${r.count}</td><td>${fmtNum(r.rps)}</td><td class="${r.failedRate > 0 ? 'bad' : ''}">${fmtPct(r.failedRate)}</td><td class="${r.mismatches > 0 ? 'warn' : ''}">${r.mismatches}</td>${pctCells(r.duration)}</tr>`,
    )
    .join('\n');
  const latency: BarRow[] = rows.map((r) => ({
    label: r.endpoint,
    value: r.duration.p95,
    overlay: r.duration.p50,
    text: `p95 ${fmtMs(r.duration.p95)} · p50 ${fmtMs(r.duration.p50)}`,
    alert: r.failedRate > 0,
  }));
  const volume: BarRow[] = rows.map((r) => ({
    label: r.endpoint,
    value: r.count,
    text: `${r.count} req · ${fmtNum(r.rps)} rps`,
  }));
  return `<h2>Endpoints <small>(top ${top} by count)</small></h2>
<div class="legend">Latency: <i style="background:#60a5fa"></i>p95 <i style="background:#1d4ed8"></i>p50 <i style="background:#ef4444"></i>has failures</div>
${barChart(latency)}
<div class="legend">Volume</div>
${barChart(volume, { color: '#a7f3d0', overlayColor: '#059669' })}
<table><thead><tr><th>endpoint</th><th>count</th><th>rps</th><th>failed</th><th>≠ log</th>${pctHeaderCells()}</tr></thead><tbody>
${table}
</tbody></table>`;
}

/** Renders the whole report as a standalone HTML document. */
export function renderHtmlReport(report: Report, top: number, options: HtmlReportOptions = {}): string {
  const h = report.header;
  const title = options.title ?? `nginx-logs-replay · ${h.mode} · ${h.prefix}`;
  const dashboard = options.dashboardHref
    ? `<p class="sub">Time series (rps, latency, VUs, component metrics over time): <a href="${escapeHtml(options.dashboardHref)}">k6 dashboard</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="sub">${escapeHtml(h.startedAt)} → ${escapeHtml(h.finishedAt)} · ${h.requests} requests in ${fmtDuration(h.testDurationMs)}</div>
${dashboard}
${renderCards(h, report.http, capacityWarning(report))}
${renderRun(h, report.http)}
${renderMismatches(report.http)}
${renderCapacity(report.capacity)}
${renderLatency(report.http)}
${renderComponents(report)}
${renderEndpoints(report.endpoints, top)}
<footer>nginx-logs-replay · generated ${escapeHtml(options.generatedAt ?? new Date().toISOString())}</footer>
</body></html>
`;
}
