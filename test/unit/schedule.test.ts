import { describe, expect, it } from 'vitest';
import {
  allocateVus,
  buildOffsets,
  iterationsPerVu,
  peakRps,
  poolIndex,
  replayMaxDuration,
  replaySpanMs,
  targetTime,
} from '../../src/lib/schedule.ts';

describe('buildOffsets', () => {
  it('spreads same-second requests evenly over one second', () => {
    expect(buildOffsets([1000, 1000, 1000, 1000, 3000])).toEqual([0, 250, 500, 750, 2000]);
  });

  it('caps the spread to the gap to the next distinct timestamp', () => {
    expect(buildOffsets([1000, 1000, 1200, 1200])).toEqual([0, 100, 200, 700]);
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
  it('targetTime scales the offset by ratio: gaps are log gaps / ratio', () => {
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

describe('peakRps', () => {
  it('finds the busiest wall-clock second of the compressed timeline', () => {
    const offsets = [0, 100, 200, 5000, 5100, 5200, 5300, 9000];
    expect(peakRps(offsets, 1)).toBe(4);
    expect(peakRps(offsets, 10)).toBe(8);
    expect(peakRps(offsets, 1, 500)).toBe(8);
    expect(peakRps([], 1)).toBe(0);
  });
});

describe('allocateVus', () => {
  it('sizes VUs from the peak rate and the assumed latency', () => {
    expect(allocateVus(369, null, null)).toEqual({ preAllocatedVUs: 369, maxVUs: 1476, auto: true, assumedLatencyMs: 500 });
    expect(allocateVus(369, null, null, 65)).toMatchObject({ preAllocatedVUs: 369, assumedLatencyMs: 500 });
    expect(allocateVus(369, null, null, 800)).toMatchObject({ preAllocatedVUs: 591, assumedLatencyMs: 800 });
    expect(allocateVus(4, null, null)).toMatchObject({ preAllocatedVUs: 10, maxVUs: 200 });
    expect(allocateVus(100_000, null, null)).toMatchObject({ preAllocatedVUs: 2000, maxVUs: 5000 });
  });

  it('honours explicit values', () => {
    expect(allocateVus(369, 5, null)).toMatchObject({ preAllocatedVUs: 5, maxVUs: 200, auto: false });
    expect(allocateVus(369, 50, 60)).toMatchObject({ preAllocatedVUs: 50, maxVUs: 60 });
    expect(allocateVus(369, 500, 60)).toMatchObject({ preAllocatedVUs: 500, maxVUs: 500 });
  });
});
