/**
 * nginx access log parser driven by a `log_format` string.
 * Pure: no k6 imports. Avoids named capture groups and the URL class so it
 * runs identically in Node and in k6's JavaScript runtime.
 */

export interface LogEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Unix time in milliseconds. */
  readonly timestamp: number;
  readonly userAgent: string;
}

export interface ParseResult {
  readonly entries: readonly LogEntry[];
  readonly malformed: number;
}

export interface LineParser {
  parse(line: string): LogEntry | null;
}

const VAR_RE = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Regex fragments for well-known nginx variables; everything else is a lazy wildcard. */
const VAR_PATTERNS: Readonly<Record<string, string>> = {
  time_local: '[^\\]]+',
  time_iso8601: '[^\\]\\s"]+',
  msec: '\\d+(?:\\.\\d+)?',
  request_time: '\\d+(?:\\.\\d+)?',
  upstream_response_time: '[^\\s"]+',
  status: '\\d{3}',
  body_bytes_sent: '\\d+|-',
  bytes_sent: '\\d+|-',
  remote_addr: '[^\\s]+',
  remote_user: '[^\\s]+',
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const TIME_LOCAL_RE = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?$/;

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CompiledFormat {
  readonly regex: RegExp;
  readonly variables: readonly string[];
}

/**
 * Turns an nginx `log_format` string into a regex whose capture groups are
 * listed in `variables` (in order). A variable inside double quotes cannot
 * contain a quote; all other variables are lazy wildcards.
 */
export function compileFormat(format: string): CompiledFormat {
  const variables: string[] = [];
  let pattern = '^';
  let last = 0;
  for (const match of format.matchAll(VAR_RE)) {
    const index = match.index ?? 0;
    const name = match[1] ?? '';
    pattern += escapeRegex(format.slice(last, index));
    const quoted = format[index - 1] === '"';
    const known = VAR_PATTERNS[name];
    const body = known ?? (quoted ? '[^"]*' : '.*?');
    pattern += `(${body})`;
    variables.push(name);
    last = index + match[0].length;
  }
  pattern += `${escapeRegex(format.slice(last))}\\s*$`;
  return { regex: new RegExp(pattern), variables };
}

/** Parses `10/Sep/2026:12:00:00 +0000` into unix milliseconds. Returns null when malformed. */
export function parseTimeLocal(value: string): number | null {
  const match = TIME_LOCAL_RE.exec(value.trim());
  if (!match) return null;
  const month = MONTHS[(match[2] ?? '').toLowerCase()];
  if (month === undefined) return null;
  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (match[7] === undefined) return utc;
  const sign = match[7] === '-' ? -1 : 1;
  const offsetMs = sign * (Number(match[8]) * 60 + Number(match[9])) * 60_000;
  return utc - offsetMs;
}

/** Parses `$msec` (`1757419200.123`) into unix milliseconds. */
export function parseMsec(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

interface RequestParts {
  readonly method: string;
  readonly path: string;
}

/** Splits `GET /path?x=1 HTTP/1.1` into method and path. */
export function parseRequest(value: string): RequestParts | null {
  const parts = value.trim().split(/\s+/);
  const method = parts[0];
  const path = parts[1];
  if (!method || !path || !path.startsWith('/')) return null;
  if (!/^[A-Z]+$/.test(method)) return null;
  return { method, path };
}

/** Creates a reusable line parser for the given `log_format`. */
export function createParser(format: string): LineParser {
  const compiled = compileFormat(format);
  const indexOf = (name: string): number => compiled.variables.indexOf(name);
  const requestIdx = indexOf('request');
  const timeLocalIdx = indexOf('time_local');
  const msecIdx = indexOf('msec');
  const statusIdx = indexOf('status');
  const agentIdx = indexOf('http_user_agent');
  if (requestIdx === -1) throw new Error('log format must contain $request');
  if (timeLocalIdx === -1 && msecIdx === -1) throw new Error('log format must contain $time_local or $msec');

  const group = (match: RegExpExecArray, idx: number): string | undefined =>
    idx === -1 ? undefined : match[idx + 1];

  return {
    parse(line: string): LogEntry | null {
      const match = compiled.regex.exec(line);
      if (!match) return null;
      const request = parseRequest(group(match, requestIdx) ?? '');
      if (!request) return null;
      const msec = msecIdx === -1 ? null : parseMsec(group(match, msecIdx) ?? '');
      const timestamp = msec ?? (timeLocalIdx === -1 ? null : parseTimeLocal(group(match, timeLocalIdx) ?? ''));
      if (timestamp === null) return null;
      const status = Number(group(match, statusIdx) ?? '0');
      const userAgent = group(match, agentIdx) ?? '';
      return { method: request.method, path: request.path, status, timestamp, userAgent };
    },
  };
}

/** Parses a whole log file. Malformed lines are counted, blank lines ignored. */
export function parseLog(text: string, format: string): ParseResult {
  const parser = createParser(format);
  const entries: LogEntry[] = [];
  let malformed = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const entry = parser.parse(line);
    if (entry) entries.push(entry);
    else malformed += 1;
  }
  return { entries, malformed };
}
