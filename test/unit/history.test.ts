import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  appendHistory,
  historyKey,
  isCapped,
  parseHistory,
  recommendFromHistory,
  seriesFor,
  type HistoryRun,
} from '../../src/lib/history.ts';

const key = 'replay|http://h|15280@1-2|debugId=x|3xx|-|-';
const run = (ratio: number, durationMs: number, plannedMs: number, achievedRps: number, at = '2026-09-10T00:00:00Z'): HistoryRun => ({
  key,
  at,
  ratio,
  plannedMs,
  durationMs,
  achievedRps,
  requests: 15280,
  failed: 0,
  lagP50Ms: 0,
  p95Ms: 500,
});

// The real series from builds #147-#152 (planned = 3599s / ratio).
const real = [
  run(20, 180_000, 180_000, 84.9),
  run(30, 120_000, 120_000, 127.3),
  run(45, 80_000, 80_000, 190.8),
  run(67.5, 53_500, 53_300, 285.8),
  run(101.3, 63_000, 35_500, 242.3),
  run(54.2, 67_000, 66_000, 229.7),
];

describe('historyKey / parse / append', () => {
  it('builds a stable key from log identity, target and options', () => {
    const k = historyKey({ prefix: 'http://h', mode: 'replay', poolKept: 15280, firstTs: 1, lastTs: 2, queryParams: [['debugId', 'x']], skipStatuses: ['3xx'], filterOnly: [], filterSkip: [] });
    expect(k).toBe('replay|http://h|15280@1-2|debugId=x|3xx||');
  });

  it('parses only valid runs and tolerates garbage', () => {
    expect(parseHistory(JSON.stringify([real[0], { key: 'x' }, 42]))).toEqual([real[0]]);
    expect(parseHistory('not json')).toEqual([]);
    expect(parseHistory(null)).toEqual([]);
  });

  it('keeps the history bounded', () => {
    let h: HistoryRun[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) h = appendHistory(h, run(i, 1000, 1000, 1));
    expect(h).toHaveLength(HISTORY_LIMIT);
    expect(h[0]?.ratio).toBe(5);
  });

  it('dedupes to the latest run per ratio and sorts by ratio', () => {
    const s = seriesFor([...real, run(45, 79_000, 80_000, 191, '2026-09-11T00:00:00Z'), { ...real[0]!, key: 'other' }], key);
    expect(s.map((r) => r.ratio)).toEqual([20, 30, 45, 54.2, 67.5, 101.3]);
    expect(s.find((r) => r.ratio === 45)?.durationMs).toBe(79_000);
  });
});

describe('isCapped', () => {
  it('needs both 10% and 5s of overrun', () => {
    expect(isCapped({ plannedMs: 35_500, durationMs: 63_000 })).toBe(true);
    expect(isCapped({ plannedMs: 53_300, durationMs: 53_500 })).toBe(false);
    expect(isCapped({ plannedMs: 1_000, durationMs: 1_400 })).toBe(false);
    expect(isCapped({ plannedMs: 60_000, durationMs: 65_000 })).toBe(false);
  });
});

describe('recommendFromHistory', () => {
  it('bisects between the fastest on-schedule ratio and the first overrun (builds #147-#152)', () => {
    const r = recommendFromHistory(real, key);
    expect(r.bestRatio).toBe(67.5);
    expect(r.cappedRatio).toBe(101.3);
    expect(r.nextRatio).toBe(82.7);
    expect(r.converged).toBe(false);
    expect(r.verdict).toContain('Fastest full replay so far: x67.5 in 53.5s (285.8 rps); x101.3 overruns (1m 03s, 242.3 rps: throughput under overload is lower, not the capacity)');
    expect(r.verdict).toContain('Suggested next run: RATIO=82.7 (between the two)');
  });

  it('declares the optimum when the bounds are within 15%', () => {
    const r = recommendFromHistory([...real, run(75, 80_000, 48_000, 190)], key);
    expect(r).toMatchObject({ bestRatio: 67.5, cappedRatio: 75, nextRatio: 67.5, converged: true });
    expect(r.verdict).toContain('Optimum found: x67.5 replays the whole log fastest (53.5s, 285.8 rps); x75 already overruns (1m 20s)');
  });

  it('probes upwards while nothing overruns and halves when everything does', () => {
    const up = recommendFromHistory(real.slice(0, 4), key);
    expect(up).toMatchObject({ bestRatio: 67.5, cappedRatio: null, nextRatio: 101.3 });
    expect(up.verdict).toContain('no run has overrun yet');
    const down = recommendFromHistory([run(100, 90_000, 36_000, 170)], key);
    expect(down).toMatchObject({ bestRatio: null, cappedRatio: 100, nextRatio: 50 });
    expect(recommendFromHistory([], key).nextRatio).toBeNull();
  });

  it('ignores runs of other keys', () => {
    expect(recommendFromHistory(real, 'other').series).toEqual([]);
  });
});
