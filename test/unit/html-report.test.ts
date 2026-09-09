import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/config.ts';
import { barChart, escapeHtml } from '../../src/lib/html-charts.ts';
import { renderHtmlReport } from '../../src/lib/html-report.ts';
import { buildReport, type K6SummaryData } from '../../src/lib/summary.ts';
import { counter, ctx, data, rateMetric, trend } from './summary.test.ts';

describe('barChart', () => {
  it('draws one bar per row scaled to the max and an overlay', () => {
    const svg = barChart([
      { label: 'a', value: 100, overlay: 50, text: '100' },
      { label: 'b', value: 50, text: '50', alert: true },
    ]);
    expect(svg).toContain('<svg');
    expect((svg.match(/<rect/g) ?? []).length).toBe(3);
    expect(svg).toContain('fill="#ef4444"');
    expect(barChart([])).toBe('');
  });

  it('escapes labels', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(barChart([{ label: '<x>', value: 1, text: 't' }])).not.toContain('<x>');
  });
});

describe('renderHtmlReport', () => {
  const html = renderHtmlReport(buildReport(data, ctx), 15, { dashboardHref: 'k6-dashboard.html', generatedAt: '2026-09-09T00:00:00Z' });

  it('is a standalone document without scripts or external assets', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/);
  });

  it('shows run, log and traffic numbers', () => {
    expect(html).toContain('2026-09-11T08:00:00.000Z → 2026-09-11T08:00:12.000Z');
    expect(html).toContain('120 requests in 12.0s');
    expect(html).toContain('original 5 · x2 = 10 avg, 12 peak');
    expect(html).toContain('10, fixed');
    expect(html).toContain('2026-09-10T12:00:00.000Z → 2026-09-10T12:00:24.000Z');
    expect(html).toContain('4 malformed lines skipped');
    expect(html).toContain('234.4 KB (avg 2.0 KB per response)');
    expect(html).toContain('6 × 5xx / transport');
    expect(html).toContain('Schedule lag p95');
    expect(html).toContain('<th>p99.9</th>');
    expect(html).toContain('429→200 ×2');
    expect(html).toContain('<td>429 → 200</td><td>2</td><td>66.67%</td>');
  });

  it('renders components and endpoints with charts and rps', () => {
    expect(html).toContain('clickhouse');
    expect((html.match(/<svg/g) ?? []).length).toBe(4);
    expect(html).toMatch(/<td>\/a<\/td><td>100<\/td><td>8\.33<\/td>/);
    expect(html).toContain('href="k6-dashboard.html"');
    expect(html).toContain('generated 2026-09-09T00:00:00Z');
  });

  it('escapes endpoint names', () => {
    const evil: K6SummaryData = {
      metrics: {
        http_reqs: counter(1, 1),
        http_req_duration: trend(1, 2, 3, 4),
        'http_reqs{endpoint:/a/<b>}': counter(1),
        'http_req_duration{endpoint:/a/<b>}': trend(1, 2, 3, 4),
        'http_req_failed{endpoint:/a/<b>}': rateMetric(0),
      },
    };
    const out = renderHtmlReport(buildReport(evil, ctx), 15);
    expect(out).toContain('/a/&lt;b&gt;');
    expect(out).not.toContain('/a/<b>');
  });

  it('flags a load generator bottleneck', () => {
    const slow: K6SummaryData = {
      state: { testRunDurationMs: 120_000 },
      metrics: { ...data.metrics, iteration_duration: trend(65, 176, 451, 1242, 39), dropped_iterations: counter(12_883) },
    };
    const out = renderHtmlReport(buildReport(slow, { ...ctx, config: parseConfig({ PREFIX: 'http://h', RATIO: '60', VUS: '5' }), targetRps: 368.76, plannedMs: 60_000 }), 15);
    expect(out).toContain('12883 requests were never sent');
    expect(out).toContain('Not sent');
    expect(html).not.toContain('never sent');
    expect(html).not.toContain('Timeline not kept');
  });

  it('explains a missing schema', () => {
    const noSchema = renderHtmlReport(buildReport(data, { ...ctx, schema: null }), 15);
    expect(noSchema).toContain('No debug schema');
    expect((noSchema.match(/<svg/g) ?? []).length).toBe(3);
  });
});
