/**
 * Plain-text table rendering with optional ANSI colors.
 * Pure: used by handleSummary through summary.ts.
 */

export type Align = 'left' | 'right';

export interface Palette {
  readonly bold: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly cyan: (s: string) => string;
  readonly green: (s: string) => string;
  readonly yellow: (s: string) => string;
  readonly red: (s: string) => string;
}

const identity = (s: string): string => s;
const ansi = (code: number) => (s: string): string => `[${code}m${s}[0m`;

export const PLAIN: Palette = { bold: identity, dim: identity, cyan: identity, green: identity, yellow: identity, red: identity };
export const ANSI: Palette = { bold: ansi(1), dim: ansi(2), cyan: ansi(36), green: ansi(32), yellow: ansi(33), red: ansi(31) };

export function palette(colors: boolean): Palette {
  return colors ? ANSI : PLAIN;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function pad(s: string, width: number, align: Align): string {
  const gap = Math.max(0, width - visibleLength(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

/** Renders a table; `aligns` defaults to left for the first column and right for the rest. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], aligns?: readonly Align[]): string {
  const alignment = headers.map((_, i) => aligns?.[i] ?? (i === 0 ? 'left' : 'right'));
  const widths = headers.map((header, i) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[i] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => pad(cell, widths[i] ?? 0, alignment[i] ?? 'left')).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), separator, ...rows.map((row) => line(row))].join('\n');
}

/** Milliseconds with adaptive precision: `0.85ms`, `12.3ms`, `1.25s`. */
export function fmtMs(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (value >= 100) return `${value.toFixed(0)}ms`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

/** Plain number with up to `digits` decimals, integers shown without decimals. */
export function fmtNum(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function fmtPct(ratio: number | undefined | null): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return '-';
  return `${(ratio * 100).toFixed(2)}%`;
}

/** Bytes as `512 B` / `1.5 KB` / `2.3 MB`. */
export function fmtBytes(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Duration in ms as `1h 02m 03s` / `45.2s` / `850ms`. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}h ${mm}m ${ss}s` : `${minutes}m ${ss}s`;
}
