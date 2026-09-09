import { describe, expect, it } from 'vitest';
import {
  buildOffsets,
  iterationsPerVu,
  poolIndex,
  replayMaxDuration,
  replaySpanMs,
  targetTime,
} from '../../src/lib/schedule.ts';

describe('buildOffsets', () => {
  it('spreads same-second requests evenly over one second', () => {
    const offsets = buildOffsets([1000, 1000, 1000, 1000, 3000]);
    expect(offsets).toEqual([0, 250, 500, 750, 2000]);
  });

  it('caps the spread to the gap to the next distinct timestamp', () => {
    const offsets = buildOffsets([1000, 1000, 1200, 1200]);
    expect(offsets).toEqual([0, 100, 200, 700]);
  });

  it('keeps millisecond precision timestamps as-is', () => {
    expect(buildOffsets([5, 17, 40])).toEqual([0, 12, 35]);
  });

  it('handles empty and single inputs', () => {
    expect(buildOffsets([])).toEqual([]);
    expect(buildOffsets([42])).toEqual([0]);
  });
});

describe('partitioning', () => {
  it('assigns each pool index to exactly one VU/iteration pair', () => {
    const n = 23;
    const vus = 5;
    const seen = new Set<number>();
    for (let vu = 1; vu <= vus; vu += 1) {
      for (let iter = 0; iter < iterationsPerVu(n, vus); iter += 1) {
        const idx = poolIndex(vu, iter, vus);
        if (idx < n) seen.add(idx);
      }
    }
    expect(seen.size).toBe(n);
    expect(iterationsPerVu(23, 5)).toBe(5);
    expect(iterationsPerVu(0, 5)).toBe(0);
  });
});

describe('timing', () => {
  it('targetTime scales the offset by ratio', () => {
    expect(targetTime(10_000, 4000, 2)).toBe(12_000);
    expect(targetTime(10_000, 4000, 0.5)).toBe(18_000);
  });

  it('replaySpanMs and replayMaxDuration', () => {
    expect(replaySpanMs([0, 500, 60_000], 2)).toBe(30_000);
    expect(replaySpanMs([], 1)).toBe(0);
    expect(replayMaxDuration([0, 60_000], 2, 5000)).toBe('65s');
    expect(replayMaxDuration([0, 1500], 1, 1000, 0)).toBe('3s');
  });
});
