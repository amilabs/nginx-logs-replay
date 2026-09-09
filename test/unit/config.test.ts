import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_FORMAT, durationToMs, parseConfig, parseQueryParams, splitList } from '../../src/lib/config.ts';

const base = { PREFIX: 'https://api.example.com/' };

describe('parseConfig', () => {
  it('applies defaults and strips trailing slash from PREFIX', () => {
    const cfg = parseConfig(base);
    expect(cfg.prefix).toBe('https://api.example.com');
    expect(cfg.mode).toBe('replay');
    expect(cfg.ratio).toBe(1);
    expect(cfg.vus).toBe(50);
    expect(cfg.maxVus).toBe(200);
    expect(cfg.format).toBe(DEFAULT_FORMAT);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.debugField).toBe('debug');
    expect(cfg.auth).toBeNull();
    expect(cfg.colors).toBe(true);
    expect(cfg.normalizeEndpoints).toBe(true);
    expect(cfg.debugTimeFactor).toBe(1);
  });

  it('rejects an unknown DEBUG_TIME_UNIT', () => {
    expect(() => parseConfig({ ...base, DEBUG_TIME_UNIT: 'minutes' })).toThrow(/DEBUG_TIME_UNIT/);
  });

  it('parses every option', () => {
    const cfg = parseConfig({
      ...base,
      MODE: 'rate',
      RATIO: '2.5',
      RPS: '120',
      DURATION: '2m',
      VUS: '10',
      MAX_VUS: '40',
      START_TS: '1700000000',
      LIMIT: '500',
      FILTER_ONLY: '/api, /service',
      FILTER_SKIP: '.php',
      QUERY_PARAMS: 'apiKey=freekey&debug=1&flag',
      CACHE_BUSTER: 'cb',
      TIMEOUT: '5s',
      INSECURE: 'true',
      AUTH: 'user:pa:ss',
      USER_AGENT: 'bench/1',
      ENDPOINT_NORMALIZE: 'false',
      DEBUG_FIELD: 'data.debug',
      DEBUG_TIME_UNIT: 's',
      DEBUG_SCHEMA: './schema.json',
      TOP: '3',
      SUMMARY_JSON: 'out.json',
      NO_COLOR: '1',
    });
    expect(cfg.mode).toBe('rate');
    expect(cfg.ratio).toBe(2.5);
    expect(cfg.rps).toBe(120);
    expect(cfg.duration).toBe('2m');
    expect(cfg.vus).toBe(10);
    expect(cfg.maxVus).toBe(40);
    expect(cfg.startTs).toBe(1700000000);
    expect(cfg.limit).toBe(500);
    expect(cfg.filterOnly).toEqual(['/api', '/service']);
    expect(cfg.filterSkip).toEqual(['.php']);
    expect(cfg.queryParams).toEqual([
      ['apiKey', 'freekey'],
      ['debug', '1'],
      ['flag', ''],
    ]);
    expect(cfg.cacheBuster).toBe('cb');
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.insecure).toBe(true);
    expect(cfg.auth).toEqual({ username: 'user', password: 'pa:ss' });
    expect(cfg.userAgent).toBe('bench/1');
    expect(cfg.normalizeEndpoints).toBe(false);
    expect(cfg.debugField).toBe('data.debug');
    expect(cfg.debugTimeFactor).toBe(1000);
    expect(cfg.debugSchema).toBe('./schema.json');
    expect(cfg.top).toBe(3);
    expect(cfg.summaryJson).toBe('out.json');
    expect(cfg.colors).toBe(false);
  });

  it('reports every problem at once', () => {
    expect.assertions(2);
    try {
      parseConfig({ MODE: 'burst', RATIO: '-1', VUS: '1.5', DURATION: '10', FORMAT: '$status' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems;
      expect(problems.map((p) => p.split(' ')[0])).toEqual([
        'PREFIX',
        'MODE',
        'RATIO',
        'VUS',
        'DURATION',
        'FORMAT',
        'FORMAT',
      ]);
    }
  });

  it('rejects PREFIX without scheme and MAX_VUS below VUS', () => {
    expect(() => parseConfig({ PREFIX: 'api.example.com', VUS: '10', MAX_VUS: '5' })).toThrow(/PREFIX must start.*\n.*MAX_VUS/s);
  });
});

describe('helpers', () => {
  it('durationToMs', () => {
    expect(durationToMs('500ms')).toBe(500);
    expect(durationToMs('30s')).toBe(30_000);
    expect(durationToMs('2m')).toBe(120_000);
    expect(durationToMs('1h')).toBe(3_600_000);
    expect(durationToMs('10')).toBeNull();
    expect(durationToMs('1.5s')).toBeNull();
  });

  it('splitList trims and drops empties', () => {
    expect(splitList(' a, ,b ,')).toEqual(['a', 'b']);
    expect(splitList(undefined)).toEqual([]);
  });

  it('parseQueryParams keeps encoding and handles = in values', () => {
    expect(parseQueryParams('a=1%202&b=x=y&&c')).toEqual([
      ['a', '1%202'],
      ['b', 'x=y'],
      ['c', ''],
    ]);
  });
});
