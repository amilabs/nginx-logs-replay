/**
 * Builds the request pool from parsed log entries and constructs URLs.
 * Pure: string-based query handling, no URL class (k6 has none built in).
 */

import type { LogEntry } from './nginx-parser.ts';

/** Compact pool entry: short keys because it is stored in a k6 SharedArray. */
export interface PoolEntry {
  /** HTTP method. */
  readonly m: string;
  /** Path with query string, as logged. */
  readonly p: string;
  /** Unix milliseconds. */
  readonly ts: number;
  /** Original status code. */
  readonly st: number;
  /** User agent from the log. */
  readonly ua: string;
}

export interface PoolFilter {
  /** Skip entries before this unix timestamp in seconds (0 = none). */
  readonly startTs: number;
  /** Keep at most this many entries (0 = all). */
  readonly limit: number;
  readonly filterOnly: readonly string[];
  readonly filterSkip: readonly string[];
  /** Original status patterns to drop (`429`, `5xx`, `50x`); empty = keep all. */
  readonly skipStatuses?: readonly string[];
}

export interface PoolStats {
  readonly total: number;
  readonly kept: number;
  readonly spanMs: number;
  readonly originalRps: number;
  /** Unix ms of the first/last replayed log entry (0 when the pool is empty). */
  readonly firstTs: number;
  readonly lastTs: number;
}

/** `429` matches exactly; `5xx` / `50x` (also written `50*`) match by digit position. */
export function statusMatches(status: number, pattern: string): boolean {
  const code = String(status);
  const mask = pattern.toLowerCase().replace(/\*/g, 'x');
  if (code.length !== 3 || mask.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    if (mask[i] !== 'x' && mask[i] !== code[i]) return false;
  }
  return true;
}

function matchesAny(path: string, needles: readonly string[]): boolean {
  return needles.some((needle) => path.includes(needle));
}

/** Filters, sorts by timestamp (stable) and compacts log entries. */
export function buildPool(entries: readonly LogEntry[], filter: PoolFilter): PoolEntry[] {
  const startMs = filter.startTs * 1000;
  const kept = entries.filter((entry) => {
    if (entry.timestamp < startMs) return false;
    if (filter.filterOnly.length > 0 && !matchesAny(entry.path, filter.filterOnly)) return false;
    if (filter.filterSkip.length > 0 && matchesAny(entry.path, filter.filterSkip)) return false;
    if (filter.skipStatuses && filter.skipStatuses.some((pattern) => statusMatches(entry.status, pattern))) return false;
    return true;
  });
  const sorted = kept
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
    .map(({ entry }) => entry);
  const limited = filter.limit > 0 ? sorted.slice(0, filter.limit) : sorted;
  return limited.map((entry) => ({
    m: entry.method,
    p: entry.path,
    ts: entry.timestamp,
    st: entry.status,
    ua: entry.userAgent,
  }));
}

/** Summary numbers about the pool for the report header. */
export function poolStats(total: number, pool: readonly PoolEntry[]): PoolStats {
  const first = pool[0];
  const last = pool[pool.length - 1];
  const spanMs = first && last ? last.ts - first.ts : 0;
  const originalRps = spanMs > 0 ? (pool.length * 1000) / spanMs : pool.length;
  return { total, kept: pool.length, spanMs, originalRps, firstTs: first?.ts ?? 0, lastTs: last?.ts ?? 0 };
}

/** Path without query string or fragment. */
export function endpointOf(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

const HEX_SEGMENT_RE = /^0[xX][0-9a-fA-F]{6,}$/;
const HASH_SEGMENT_RE = /^[0-9a-fA-F]{32,}$/;
const NUMBER_SEGMENT_RE = /^\d+$/;
const UUID_SEGMENT_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function normalizeSegment(segment: string): string {
  if (HEX_SEGMENT_RE.test(segment)) return ':hex';
  if (UUID_SEGMENT_RE.test(segment)) return ':uuid';
  if (HASH_SEGMENT_RE.test(segment)) return ':hash';
  if (NUMBER_SEGMENT_RE.test(segment)) return ':n';
  return segment;
}

/**
 * Endpoint tag for a path: query dropped and, when `normalize` is on, ids
 * replaced by placeholders so `/getAddressInfo/0xabc…` and
 * `/getAddressInfo/0xdef…` share one row.
 */
export function endpointTag(path: string, normalize: boolean): string {
  const endpoint = endpointOf(path);
  if (!normalize) return endpoint;
  return endpoint.split('/').map(normalizeSegment).join('/');
}

/**
 * Sets or overrides query parameters on a path. Existing keys are replaced
 * in place; new keys are appended. Encoding is passed through untouched.
 */
export function setQueryParams(path: string, params: readonly (readonly [string, string])[]): string {
  if (params.length === 0) return path;
  const hash = path.indexOf('#');
  const base = hash === -1 ? path : path.slice(0, hash);
  const fragment = hash === -1 ? '' : path.slice(hash);
  const question = base.indexOf('?');
  const pathname = question === -1 ? base : base.slice(0, question);
  const query = question === -1 ? '' : base.slice(question + 1);
  const pairs = query === '' ? [] : query.split('&').filter((pair) => pair.length > 0);
  const overridden = params.reduce<string[]>((acc, [key, value]) => {
    const encoded = value === '' ? key : `${key}=${value}`;
    const idx = acc.findIndex((pair) => pair === key || pair.startsWith(`${key}=`));
    if (idx === -1) return [...acc, encoded];
    return acc.map((pair, i) => (i === idx ? encoded : pair));
  }, pairs);
  return `${pathname}?${overridden.join('&')}${fragment}`;
}

export interface UrlOptions {
  readonly prefix: string;
  readonly queryParams: readonly (readonly [string, string])[];
  readonly cacheBuster: string;
  /** Unique value for the cache buster; ignored when cacheBuster is empty. */
  readonly nonce: string;
}

/** Full request URL: prefix + path with overrides and optional cache buster. */
export function buildUrl(path: string, options: UrlOptions): string {
  const extra: (readonly [string, string])[] = options.cacheBuster
    ? [...options.queryParams, [options.cacheBuster, options.nonce]]
    : [...options.queryParams];
  return `${options.prefix}${setQueryParams(path, extra)}`;
}

/** Distinct original status codes in the pool, ascending. */
export function poolStatuses(pool: readonly PoolEntry[]): number[] {
  const seen = new Set<number>();
  for (const entry of pool) seen.add(entry.st);
  return [...seen].sort((a, b) => a - b);
}

/** Most frequent endpoints in the pool, descending by count. */
export function topEndpoints(pool: readonly PoolEntry[], limit: number, normalize = true): { endpoint: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of pool) {
    const endpoint = endpointTag(entry.p, normalize);
    counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([endpoint, count]) => ({ endpoint, count }))
    .sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint))
    .slice(0, limit);
}
