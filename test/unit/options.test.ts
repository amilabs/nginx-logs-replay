import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/config.ts';
import { SCENARIO_NAME, buildOptions, buildScenario, buildThresholds, replayVus } from '../../src/lib/options.ts';

describe('buildThresholds', () => {
  it('creates three always-passing thresholds per safe endpoint', () => {
    const thresholds = buildThresholds([
      { endpoint: '/api/v1/x', count: 5 },
      { endpoint: '/bad,name}', count: 1 },
    ]);
    expect(Object.keys(thresholds)).toEqual([
      'http_reqs{endpoint:/api/v1/x}',
      'http_req_duration{endpoint:/api/v1/x}',
      'http_req_failed{endpoint:/api/v1/x}',
    ]);
    expect(thresholds['http_req_duration{endpoint:/api/v1/x}']).toEqual(['max>=0']);
  });
});

describe('buildScenario', () => {
  it('replay: per-vu-iterations covering the pool with a safety margin', () => {
    const config = parseConfig({ PREFIX: 'http://h', VUS: '4', RATIO: '2', TIMEOUT: '5s' });
    expect(buildScenario({ config, poolSize: 10, offsets: [0, 60_000] })).toEqual({
      executor: 'per-vu-iterations',
      vus: 4,
      iterations: 3,
      maxDuration: '65s',
      gracefulStop: '5s',
    });
  });

  it('replay: never allocates more VUs than requests', () => {
    const config = parseConfig({ PREFIX: 'http://h', VUS: '50' });
    expect(replayVus(config, 3)).toBe(3);
    expect(replayVus(config, 500)).toBe(50);
    expect(replayVus(config, 0)).toBe(1);
    expect(buildScenario({ config, poolSize: 3, offsets: [0, 1, 2] })).toMatchObject({ vus: 3, iterations: 1 });
    expect(buildScenario({ config, poolSize: 0, offsets: [] })).toMatchObject({ vus: 1, iterations: 1 });
  });

  it('rate: constant-arrival-rate', () => {
    const config = parseConfig({ PREFIX: 'http://h', MODE: 'rate', RPS: '25', DURATION: '2m', VUS: '10', MAX_VUS: '30' });
    expect(buildScenario({ config, poolSize: 10, offsets: [] })).toEqual({
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 30,
      gracefulStop: '30s',
    });
  });
});

describe('buildOptions', () => {
  it('assembles scenario, thresholds and global settings', () => {
    const config = parseConfig({ PREFIX: 'http://h', INSECURE: 'true', USER_AGENT: 'bench' });
    const options = buildOptions({ config, poolSize: 2, offsets: [0, 1], topEndpoints: [{ endpoint: '/a', count: 2 }] });
    expect(Object.keys(options.scenarios as object)).toEqual([SCENARIO_NAME]);
    expect(options.thresholds).toHaveProperty('http_reqs{endpoint:/a}');
    expect(options.insecureSkipTLSVerify).toBe(true);
    expect(options.userAgent).toBe('bench');
    expect(options.summaryTrendStats).toContain('p(99)');
  });

  it('keeps the log user agent when USER_AGENT=log', () => {
    const config = parseConfig({ PREFIX: 'http://h' });
    expect(buildOptions({ config, poolSize: 1, offsets: [0], topEndpoints: [] }).userAgent).toBeUndefined();
  });
});
