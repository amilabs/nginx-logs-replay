import { describe, expect, it } from 'vitest';
import { ANSI, PLAIN, fmtBytes, fmtDuration, fmtMs, fmtNum, fmtPct, palette, table } from '../../src/lib/format.ts';

describe('table', () => {
  it('aligns first column left and the rest right', () => {
    const out = table(['name', 'v'], [['a', '1'], ['longer', '22']]);
    expect(out.split('\n')).toEqual(['name     v', '------  --', 'a        1', 'longer  22']);
    expect(table(['a', 'b'], [['x', 'y']], ['right', 'left']).split('\n')[2]).toBe('x  y');
  });

  it('ignores ANSI codes when measuring width', () => {
    const out = table(['h'], [[ANSI.red('x')]]);
    expect(out.split('\n')[2]).toBe(ANSI.red('x'));
  });
});

describe('formatters', () => {
  it('fmtMs adapts precision', () => {
    expect(fmtMs(0.851)).toBe('0.85ms');
    expect(fmtMs(12.34)).toBe('12.3ms');
    expect(fmtMs(123.4)).toBe('123ms');
    expect(fmtMs(1250)).toBe('1.25s');
    expect(fmtMs(null)).toBe('-');
  });

  it('fmtNum / fmtPct', () => {
    expect(fmtNum(3)).toBe('3');
    expect(fmtNum(3.14159)).toBe('3.14');
    expect(fmtNum(undefined)).toBe('-');
    expect(fmtPct(0.1234)).toBe('12.34%');
    expect(fmtPct(NaN)).toBe('-');
  });

  it('fmtBytes', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(2.3 * 1024 * 1024)).toBe('2.3 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(fmtBytes(null)).toBe('-');
  });

  it('fmtDuration', () => {
    expect(fmtDuration(850)).toBe('850ms');
    expect(fmtDuration(45_200)).toBe('45.2s');
    expect(fmtDuration(125_000)).toBe('2m 05s');
    expect(fmtDuration(3_723_000)).toBe('1h 02m 03s');
    expect(fmtDuration(-1)).toBe('-');
  });

  it('palette switches colors', () => {
    expect(palette(false)).toBe(PLAIN);
    expect(palette(true).bold('x')).toBe('[1mx[0m');
  });
});
