/**
 * Typed configuration parsed from k6's `__ENV` (`-e KEY=value`).
 * Pure: no k6 imports, fully unit-testable.
 */

export type Mode = 'replay' | 'rate';

export interface BasicAuth {
  readonly username: string;
  readonly password: string;
}

export interface Config {
  readonly prefix: string;
  readonly log: string;
  readonly mode: Mode;
  readonly ratio: number;
  readonly rps: number;
  readonly duration: string;
  readonly vus: number;
  readonly maxVus: number;
  readonly format: string;
  readonly startTs: number;
  readonly limit: number;
  readonly filterOnly: readonly string[];
  readonly filterSkip: readonly string[];
  readonly queryParams: readonly (readonly [string, string])[];
  readonly cacheBuster: string;
  readonly timeout: string;
  readonly timeoutMs: number;
  readonly insecure: boolean;
  readonly auth: BasicAuth | null;
  readonly userAgent: string;
  readonly normalizeEndpoints: boolean;
  readonly debugField: string;
  /** Factor that converts debug `time` values to milliseconds (1 for ms, 1000 for s). */
  readonly debugTimeFactor: number;
  readonly debugSchema: string;
  readonly discoverN: number;
  readonly top: number;
  readonly summaryJson: string;
  readonly colors: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_FORMAT =
  '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';

export const DEFAULTS = {
  log: './access.log',
  mode: 'replay' as Mode,
  ratio: 1,
  rps: 10,
  duration: '60s',
  vus: 50,
  timeout: '30s',
  userAgent: 'log',
  debugField: 'debug',
  debugSchema: './debug-schema.json',
  discoverN: 5,
  top: 15,
  summaryJson: './summary.json',
} as const;

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Converts a k6-style duration (`30s`, `5m`, `500ms`) to milliseconds. Returns null when malformed. */
export function durationToMs(value: string): number | null {
  const match = DURATION_RE.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = DURATION_UNIT_MS[match[2] ?? ''];
  return unit === undefined ? null : amount * unit;
}

/** Splits a comma-separated list, trimming and dropping empty items. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Parses `a=1&b=2` into ordered pairs. Values keep their original encoding. */
export function parseQueryParams(value: string | undefined): [string, string][] {
  if (!value) return [];
  return value
    .split('&')
    .filter((pair) => pair.length > 0)
    .map((pair): [string, string] => {
      const eq = pair.indexOf('=');
      return eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
    });
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseAuth(value: string | undefined): BasicAuth | null {
  if (!value) return null;
  const colon = value.indexOf(':');
  if (colon === -1) return { username: value, password: '' };
  return { username: value.slice(0, colon), password: value.slice(colon + 1) };
}

interface NumberRule {
  readonly key: string;
  readonly fallback: number;
  readonly min: number;
  readonly integer: boolean;
}

function readNumber(env: Env, rule: NumberRule, problems: string[]): number {
  const raw = env[rule.key];
  if (raw === undefined || raw === '') return rule.fallback;
  const parsed = Number(raw);
  const valid = Number.isFinite(parsed) && parsed >= rule.min && (!rule.integer || Number.isInteger(parsed));
  if (!valid) {
    const kind = rule.integer ? 'an integer' : 'a number';
    problems.push(`${rule.key} must be ${kind} >= ${rule.min}, got "${raw}"`);
    return rule.fallback;
  }
  return parsed;
}

function readDuration(env: Env, key: string, fallback: string, problems: string[]): string {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (durationToMs(raw) === null) {
    problems.push(`${key} must look like 30s, 5m, 500ms; got "${raw}"`);
    return fallback;
  }
  return raw.trim();
}

/**
 * Builds a validated Config from environment variables.
 * Throws ConfigError listing every problem at once.
 */
export function parseConfig(env: Env): Config {
  const problems: string[] = [];

  const prefix = (env.PREFIX ?? '').trim().replace(/\/+$/, '');
  if (!prefix) {
    problems.push('PREFIX is required, e.g. -e PREFIX=https://api.example.com');
  } else if (!/^https?:\/\//.test(prefix)) {
    problems.push(`PREFIX must start with http:// or https://, got "${prefix}"`);
  }

  const modeRaw = (env.MODE ?? DEFAULTS.mode).trim();
  const mode: Mode = modeRaw === 'rate' ? 'rate' : 'replay';
  if (modeRaw !== 'replay' && modeRaw !== 'rate') {
    problems.push(`MODE must be "replay" or "rate", got "${modeRaw}"`);
  }

  const ratio = readNumber(env, { key: 'RATIO', fallback: DEFAULTS.ratio, min: 0.001, integer: false }, problems);
  const rps = readNumber(env, { key: 'RPS', fallback: DEFAULTS.rps, min: 0.001, integer: false }, problems);
  const vus = readNumber(env, { key: 'VUS', fallback: DEFAULTS.vus, min: 1, integer: true }, problems);
  const maxVus = readNumber(env, { key: 'MAX_VUS', fallback: vus * 4, min: 1, integer: true }, problems);
  if (maxVus < vus) problems.push(`MAX_VUS (${maxVus}) must be >= VUS (${vus})`);
  const startTs = readNumber(env, { key: 'START_TS', fallback: 0, min: 0, integer: false }, problems);
  const limit = readNumber(env, { key: 'LIMIT', fallback: 0, min: 0, integer: true }, problems);
  const discoverN = readNumber(env, { key: 'DISCOVER_N', fallback: DEFAULTS.discoverN, min: 1, integer: true }, problems);
  const top = readNumber(env, { key: 'TOP', fallback: DEFAULTS.top, min: 0, integer: true }, problems);

  const duration = readDuration(env, 'DURATION', DEFAULTS.duration, problems);
  const timeout = readDuration(env, 'TIMEOUT', DEFAULTS.timeout, problems);

  const format = env.FORMAT && env.FORMAT.trim() ? env.FORMAT : DEFAULT_FORMAT;
  if (!format.includes('$request')) problems.push('FORMAT must contain $request');
  if (!format.includes('$time_local') && !format.includes('$msec')) {
    problems.push('FORMAT must contain $time_local or $msec');
  }

  const debugField = (env.DEBUG_FIELD ?? DEFAULTS.debugField).trim();
  if (!debugField) problems.push('DEBUG_FIELD must not be empty (use DEBUG_SCHEMA=none to disable debug metrics)');

  const debugTimeUnit = (env.DEBUG_TIME_UNIT ?? 'ms').trim().toLowerCase();
  const debugTimeFactor = debugTimeUnit === 's' ? 1000 : debugTimeUnit === 'us' ? 0.001 : 1;
  if (!['ms', 's', 'us'].includes(debugTimeUnit)) {
    problems.push(`DEBUG_TIME_UNIT must be "ms", "s" or "us", got "${debugTimeUnit}"`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    prefix,
    log: env.LOG && env.LOG.trim() ? env.LOG.trim() : DEFAULTS.log,
    mode,
    ratio,
    rps,
    duration,
    vus,
    maxVus,
    format,
    startTs,
    limit,
    filterOnly: splitList(env.FILTER_ONLY),
    filterSkip: splitList(env.FILTER_SKIP),
    queryParams: parseQueryParams(env.QUERY_PARAMS),
    cacheBuster: (env.CACHE_BUSTER ?? '').trim(),
    timeout,
    timeoutMs: durationToMs(timeout) ?? 30_000,
    insecure: parseBool(env.INSECURE, false),
    auth: parseAuth(env.AUTH),
    userAgent: env.USER_AGENT && env.USER_AGENT.trim() ? env.USER_AGENT.trim() : DEFAULTS.userAgent,
    normalizeEndpoints: parseBool(env.ENDPOINT_NORMALIZE, true),
    debugField,
    debugTimeFactor,
    debugSchema: env.DEBUG_SCHEMA && env.DEBUG_SCHEMA.trim() ? env.DEBUG_SCHEMA.trim() : DEFAULTS.debugSchema,
    discoverN,
    top,
    summaryJson: env.SUMMARY_JSON && env.SUMMARY_JSON.trim() ? env.SUMMARY_JSON.trim() : DEFAULTS.summaryJson,
    colors: !parseBool(env.NO_COLOR, false),
  };
}
