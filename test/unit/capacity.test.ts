import { describe, expect, it } from 'vitest';
import { analyzeCapacity, isDegraded, loadEdges, loadTag, offeredRps, recommendRatio, type LoadRow } from '../../src/lib/capacity.ts';

const pct = (p95: number, avg = p95 / 2) => ({ min: 1, avg, p50: avg, p75: avg, p90: p95, p95, p99: p95 * 2, p999: p95 * 3, max: p95 * 3 });
const row = (upToRps: number, p95: number, count = 100, failedRate = 0): LoadRow => ({ upToRps, count, failedRate, duration: pct(p95) });

describe('offeredRps', () => {
  it('counts requests due in the trailing second on the compressed timeline', () => {
    expect(offeredRps([0, 100, 200, 5000, 5100, 5200, 5300, 9000], 1)).toEqual([1, 2, 3, 1, 2, 3, 4, 1]);
    expect(offeredRps([0, 100, 200, 5000, 5100, 5200, 5300, 9000], 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(offeredRps([], 1)).toEqual([]);
  });
});

describe('loadEdges / loadTag', () => {
  it('splits the peak into increasing integer edges', () => {
    expect(loadEdges(352)).toEqual([44, 88, 132, 176, 220, 264, 308, 352]);
    expect(loadEdges(3)).toEqual([1, 2, 3]);
    expect(loadEdges(0)).toEqual([]);
  });

  it('tags a rate with its bucket upper edge', () => {
    const edges = loadEdges(352);
    expect(loadTag(1, edges)).toBe('44');
    expect(loadTag(44, edges)).toBe('44');
    expect(loadTag(45, edges)).toBe('88');
    expect(loadTag(999, edges)).toBe('352');
  });
});

describe('analyzeCapacity', () => {
  it('finds the knee where p95 doubles the low-load reference', () => {
    const rows = [row(44, 60), row(88, 70), row(132, 90), row(176, 110), row(220, 400), row(264, 900), row(308, 2000), row(352, 2900)];
    const a = analyzeCapacity(rows);
    expect(a.referenceP95).toBe(60);
    expect(a.healthyUpToRps).toBe(176);
    expect(a.degradedFromRps).toBe(220);
    expect(isDegraded(row(220, 400), 60)).toBe(true);
    expect(isDegraded(row(176, 110), 60)).toBe(false);
  });

  it('treats failures as degradation and skips thin buckets', () => {
    const rows = [row(44, 60), row(88, 65, 5), row(132, 70, 100, 0.05), row(176, 80)];
    const a = analyzeCapacity(rows);
    expect(a.healthyUpToRps).toBe(44);
    expect(a.degradedFromRps).toBe(132);
  });

  it('reports no knee when nothing degrades', () => {
    const a = analyzeCapacity([row(44, 60), row(88, 70), row(132, 100)]);
    expect(a.degradedFromRps).toBeNull();
    expect(a.healthyUpToRps).toBe(132);
    expect(analyzeCapacity([]).referenceP95).toBeNull();
  });
});

describe('recommendRatio', () => {
  it('converts the knee into a RATIO using the log peak', () => {
    const a = analyzeCapacity([row(44, 60), row(88, 70), row(132, 90), row(176, 110), row(220, 400), row(352, 2900)]);
    const r = recommendRatio(a, 20, 17.6);
    expect(r.safeRatio).toBe(10);
    expect(r.nextRatio).toBe(10);
    expect(r.verdict).toContain('Healthy up to ~176 rps, degraded from ~220 rps');
    expect(r.verdict).toContain('highest RATIO without degradation is about x10');
  });

  it('suggests going up when nothing degraded and down when everything did', () => {
    const fine = recommendRatio(analyzeCapacity([row(44, 60), row(88, 70)]), 20, 17.6);
    expect(fine).toMatchObject({ nextRatio: 30, safeRatio: 20 });
    expect(fine.verdict).toContain('Try RATIO=30');
    const bad = recommendRatio(analyzeCapacity([row(44, 60), row(88, 70, 100, 0.5)]), 20, 17.6);
    expect(bad.safeRatio).toBe(round(44 / 17.6));
    const worst = recommendRatio({ rows: [row(44, 60, 100, 0.5)], referenceP95: 60, healthyUpToRps: null, degradedFromRps: 44 }, 20, 17.6);
    expect(worst).toMatchObject({ nextRatio: 10, safeRatio: null });
    expect(recommendRatio(analyzeCapacity([]), 20, 17.6).nextRatio).toBeNull();
  });
});

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
