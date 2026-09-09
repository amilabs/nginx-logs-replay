/**
 * k6 glue: executes one pool entry against the target and records
 * status mismatches and debug samples.
 */

import encoding from 'k6/encoding';
import http, { type RefinedResponse, type ResponseType } from 'k6/http';
import type { Config } from '../lib/config.ts';
import { getByPath } from '../lib/debug-walker.ts';
import { buildUrl, endpointTag, type PoolEntry } from '../lib/request-pool.ts';
import { recordDebug, statusMismatch, type DebugMetrics } from './metrics.ts';

export type Response = RefinedResponse<ResponseType | undefined>;

export interface RequestContext {
  readonly config: Config;
  readonly metrics: DebugMetrics | null;
  /** Headers shared by every request (auth); computed once in init. */
  readonly baseHeaders: Readonly<Record<string, string>>;
}

/** Builds the per-run request context. Call in the init context. */
export function createRequestContext(config: Config, metrics: DebugMetrics | null): RequestContext {
  const baseHeaders: Record<string, string> = {};
  if (config.auth) {
    baseHeaders.Authorization = `Basic ${encoding.b64encode(`${config.auth.username}:${config.auth.password}`)}`;
  }
  return { config, metrics, baseHeaders };
}

function headersFor(ctx: RequestContext, entry: PoolEntry): Record<string, string> {
  if (ctx.config.userAgent !== 'log' || !entry.ua || entry.ua === '-') return ctx.baseHeaders;
  return { ...ctx.baseHeaders, 'User-Agent': entry.ua };
}

/** Parses the JSON body and extracts the debug object; undefined when absent. */
export function extractDebug(res: Response, debugField: string): unknown {
  try {
    return getByPath(res.json(), debugField);
  } catch {
    return undefined;
  }
}

/** Sends the request and records custom metrics. Returns the k6 response. */
export function performRequest(ctx: RequestContext, entry: PoolEntry, nonce: string): Response {
  const endpoint = endpointTag(entry.p, ctx.config.normalizeEndpoints);
  const url = buildUrl(entry.p, {
    prefix: ctx.config.prefix,
    queryParams: ctx.config.queryParams,
    cacheBuster: ctx.config.cacheBuster,
    nonce,
  });
  const tags = { endpoint, name: endpoint };
  const res = http.request(entry.m, url, null, {
    headers: headersFor(ctx, entry),
    tags,
    timeout: ctx.config.timeout,
  });
  if (res.status !== entry.st) statusMismatch.add(1, tags);
  if (ctx.metrics) recordDebug(ctx.metrics, extractDebug(res, ctx.config.debugField), tags);
  return res;
}
