import { describe, expect, it } from 'vitest';
import { analyzeCapacity, isDegraded, loadEdges, loadTag, minSamples, offeredRps, recommendFastest, type LoadRow } from '../../src/lib/capacity.ts';

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
  it('requires 100 requests and 2% of the run per bucket', () => {
    expect(minSamples(20)).toBe(100);
    expect(minSamples(15_280)).toBe(306);
  });

  it('finds the knee where p95 doubles the low-load reference', () => {
    const rows = [row(44, 60), row(88, 70), row(132, 90), row(176, 110), row(220, 400), row(264, 900), row(308, 2000), row(352, 2900)];
    const a = analyzeCapacity(rows);
    expect(a.referenceP95).toBe(60);
    expect(a.healthyUpToRps).toBe(176);
    expect(a.degradedFromRps).toBe(220);
    expect(isDegraded(row(220, 400), 60)).toBe(true);
    expect(isDegraded(row(176, 110), 60)).toBe(false);
    expect(isDegraded(row(176, 300), 60)).toBe(false);
  });

  it('treats failures as degradation and skips thin buckets', () => {
    const rows = [row(44, 60), row(88, 65, 5), row(132, 70, 100, 0.05), row(176, 80)];
    const a = analyzeCapacity(rows);
    expect(a.healthyUpToRps).toBe(44);
    expect(a.degradedFromRps).toBe(132);
  });

  it('ignores thin low-load buckets (build 141: 28 and 71 requests out of 15k)', () => {
    const rows = [row(28, 152, 28), row(56, 841, 71), row(83, 163, 2353), row(111, 296, 7154), row(139, 906, 2840), row(166, 2693, 1176), row(194, 960, 1337), row(221, 1386, 321)];
    const a = analyzeCapacity(rows, 78);
    expect(a.referenceP95).toBe(163);
    expect(a.healthyUpToRps).toBe(111);
    expect(a.degradedFromRps).toBe(139);
  });

  it('anchors the reference to the discover probe when every bucket is slow', () => {
    const rows = [row(28, 247, 28), row(56, 2348, 71), row(83, 2494, 2353), row(111, 3221, 7154), row(166, 9070, 1176)];
    const a = analyzeCapacity(rows, 117);
    expect(a.referenceP95).toBe(351);
    expect(a.healthyUpToRps).toBeNull();
    expect(a.degradedFromRps).toBe(83);
    expect(analyzeCapacity(rows, null).referenceP95).toBe(2494);
  });

  it('reports no knee when nothing degrades', () => {
    const a = analyzeCapacity([row(44, 60), row(88, 70), row(132, 100)]);
    expect(a.degradedFromRps).toBeNull();
    expect(a.healthyUpToRps).toBe(132);
    expect(analyzeCapacity([]).referenceP95).toBeNull();
  });
});

describe('recommendFastest', () => {
  const knee = analyzeCapacity([row(44, 60), row(88, 70), row(132, 90), row(176, 110), row(220, 400), row(352, 2900)]);
  const base = { ratio: 20, originalAvgRps: 6.15, originalPeakRps: 17.6, achievedRps: 123, plannedMs: 180_000, durationMs: 181_000, lagP50: 0, dropped: 0, knee };

  it('raises the ratio while the replay finishes on schedule', () => {
    const r = recommendFastest(base);
    expect(r).toMatchObject({ nextRatio: 30, kneeRatio: 10, capped: false });
    expect(r.verdict).toContain('On schedule at x20: the full replay took 3m 01s vs planned 3m 00s and the target kept up (median lag 0.00ms). Suggested next run: RATIO=30 (×1.5)');
    expect(r.verdict).toContain('Latency starts climbing around ~220 rps (~x10)');
  });

  it('steps up gently when bursts already queue', () => {
    const r = recommendFastest({ ...base, lagP50: 1400 });
    expect(r).toMatchObject({ nextRatio: 24, capped: false });
    expect(r.verdict).toContain('requests already queue during bursts (median lag 1.40s)');
  });

  it('derives the fastest ratio from the throughput cap when the run overran its plan', () => {
    const r = recommendFastest({ ...base, ratio: 25, achievedRps: 106, plannedMs: 144_000, durationMs: 187_000, lagP50: 12_000 });
    expect(r).toMatchObject({ nextRatio: 16.4, capped: true });
    expect(r.verdict).toContain('At x25 the target capped at ~106 rps: the full replay took 3m 07s, 43.0s longer than the planned 2m 24s');
    expect(r.verdict).toContain('Fastest full replay ≈ RATIO x16.4 (106 rps ÷ 6.2 rps average of the log, minus 5%). Suggested next run: RATIO=16.4');
    const dropped = recommendFastest({ ...base, achievedRps: 200, dropped: 500 });
    expect(dropped.capped).toBe(true);
    expect(dropped.nextRatio).toBe(16);
    expect(dropped.verdict).toContain('and 500 requests were never sent');
  });

  it('reports missing data', () => {
    const r = recommendFastest({ ...base, plannedMs: null });
    expect(r.nextRatio).toBeNull();
    expect(r.verdict).toContain('Not enough data');
    expect(recommendFastest({ ...base, knee: analyzeCapacity([row(44, 60), row(88, 70)]) }).verdict).toContain('Latency stayed flat across all load levels');
  });
});
