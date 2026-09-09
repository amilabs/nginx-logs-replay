import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/lib/nginx-parser.ts';
import {
  buildPool,
  buildUrl,
  endpointOf,
  endpointTag,
  poolStats,
  setQueryParams,
  topEndpoints,
} from '../../src/lib/request-pool.ts';

const entry = (path: string, timestamp: number, status = 200): LogEntry => ({
  method: 'GET',
  path,
  status,
  timestamp,
  userAgent: 'ua',
});

const noFilter = { startTs: 0, limit: 0, filterOnly: [], filterSkip: [] };

describe('buildPool', () => {
  it('sorts by timestamp keeping log order for ties and compacts entries', () => {
    const pool = buildPool([entry('/b', 2000), entry('/a', 1000), entry('/c', 2000)], noFilter);
    expect(pool.map((e) => e.p)).toEqual(['/a', '/b', '/c']);
    expect(pool[0]).toEqual({ m: 'GET', p: '/a', ts: 1000, st: 200, ua: 'ua' });
  });

  it('applies startTs (seconds), filters and limit', () => {
    const entries = [entry('/api/x', 1000), entry('/api/y.php', 2000), entry('/other', 3000), entry('/api/z', 4000)];
    expect(buildPool(entries, { ...noFilter, startTs: 2 }).map((e) => e.p)).toEqual(['/api/y.php', '/other', '/api/z']);
    expect(buildPool(entries, { ...noFilter, filterOnly: ['/api'] }).map((e) => e.p)).toEqual(['/api/x', '/api/y.php', '/api/z']);
    expect(buildPool(entries, { ...noFilter, filterOnly: ['/api'], filterSkip: ['.php'] }).map((e) => e.p)).toEqual(['/api/x', '/api/z']);
    expect(buildPool(entries, { ...noFilter, limit: 2 }).map((e) => e.p)).toEqual(['/api/x', '/api/y.php']);
  });
});

describe('poolStats', () => {
  it('computes span and original rps', () => {
    const pool = buildPool([entry('/a', 0), entry('/b', 1000), entry('/c', 4000)], noFilter);
    expect(poolStats(5, pool)).toEqual({ total: 5, kept: 3, spanMs: 4000, originalRps: 0.75 });
    expect(poolStats(0, [])).toEqual({ total: 0, kept: 0, spanMs: 0, originalRps: 0 });
  });
});

describe('endpointOf / setQueryParams', () => {
  it('strips query and fragment', () => {
    expect(endpointOf('/a/b?x=1#f')).toBe('/a/b');
    expect(endpointOf('/a/b')).toBe('/a/b');
  });

  it('endpointTag normalizes ids when enabled', () => {
    const hex = `0x${'ab'.repeat(20)}`;
    expect(endpointTag(`/getAddressInfo/${hex}?apiKey=k`, true)).toBe('/getAddressInfo/:hex');
    expect(endpointTag(`/tx/${'f'.repeat(64)}`, true)).toBe('/tx/:hex'.replace(':hex', ':hash'));
    expect(endpointTag('/block/12345/txs', true)).toBe('/block/:n/txs');
    expect(endpointTag('/u/123e4567-e89b-12d3-a456-426614174000', true)).toBe('/u/:uuid');
    expect(endpointTag('/service/service.php?data=0xabc', true)).toBe('/service/service.php');
    expect(endpointTag(`/getAddressInfo/${hex}`, false)).toBe(`/getAddressInfo/${hex}`);
  });

  it('overrides existing keys in place and appends new ones', () => {
    expect(setQueryParams('/p?a=1&b=2', [['b', '3'], ['c', '4']])).toBe('/p?a=1&b=3&c=4');
    expect(setQueryParams('/p', [['a', '1']])).toBe('/p?a=1');
    expect(setQueryParams('/p?a', [['a', '2']])).toBe('/p?a=2');
    expect(setQueryParams('/p?a=1#frag', [['b', '']])).toBe('/p?a=1&b#frag');
    expect(setQueryParams('/p?a=1', [])).toBe('/p?a=1');
  });
});

describe('buildUrl', () => {
  it('joins prefix, overrides and cache buster', () => {
    const url = buildUrl('/getAddressInfo/0x1?apiKey=old', {
      prefix: 'https://api.example.com',
      queryParams: [['apiKey', 'new']],
      cacheBuster: 'cb',
      nonce: '1-2-3',
    });
    expect(url).toBe('https://api.example.com/getAddressInfo/0x1?apiKey=new&cb=1-2-3');
  });

  it('leaves the path untouched without overrides or buster', () => {
    expect(buildUrl('/x?y=1', { prefix: 'http://h', queryParams: [], cacheBuster: '', nonce: 'n' })).toBe('http://h/x?y=1');
  });
});

describe('topEndpoints', () => {
  it('ranks by count then name and honours the limit', () => {
    const pool = buildPool(
      [entry('/a?1', 1), entry('/b', 2), entry('/a?2', 3), entry('/c', 4), entry('/b?x', 5)],
      noFilter,
    );
    expect(topEndpoints(pool, 2)).toEqual([
      { endpoint: '/a', count: 2 },
      { endpoint: '/b', count: 2 },
    ]);
    expect(topEndpoints(pool, 0)).toEqual([]);
  });

  it('groups normalized endpoints', () => {
    const pool = buildPool([entry('/addr/0x1111111111', 1), entry('/addr/0x2222222222', 2), entry('/x', 3)], noFilter);
    expect(topEndpoints(pool, 5)).toEqual([
      { endpoint: '/addr/:hex', count: 2 },
      { endpoint: '/x', count: 1 },
    ]);
    expect(topEndpoints(pool, 5, false)).toHaveLength(3);
  });
});
