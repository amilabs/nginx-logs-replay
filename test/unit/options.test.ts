import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/config.ts';
import { SCENARIO_NAME, buildLoadPlan, buildOptions, buildThresholds } from '../../src/lib/options.ts';

describe('buildThresholds', () => {
  it('creates always-passing thresholds per safe endpoint', () => {
    const thresholds = buildThresholds([
      { endpoint: '/api/v1/x', count: 5 },
      { endpoint: '/bad,name}', count: 1 },
    ]);
    expect(Object.keys(thresholds)).toEqual([
      'http_reqs{endpoint:/api/v1/x}',
      'http_req_duration{endpoint:/api/v1/x}',
      'http_req_failed{endpoint:/api/v1/x}',
      'replay_status_mismatch{endpoint:/api/v1/x}',
    ]);
    expect(thresholds['http_req_duration{endpoint:/api/v1/x}']).toEqual(['max>=0']);
  });

  it('adds mismatch pair sub-metrics for the log statuses', () => {
    const thresholds = buildThresholds([], [200, 429]);
    expect(thresholds).toHaveProperty('replay_status_mismatch{from:429,to:200}');
    expect(thresholds).toHaveProperty('replay_status_mismatch{from:200,to:429}');
    expect(thresholds).not.toHaveProperty('replay_status_mismatch{from:200,to:200}');
  });
});

describe('buildLoadPlan', () => {
  // 10 requests over 9s of log time
  const timestamps = Array.from({ length: 10 }, (_, i) => i * 1000);

  it('replay: exact timeline with automatically sized VUs', () => {
    const config = parseConfig({ PREFIX: 'http://h', RATIO: '2', TIMEOUT: '5s' });
    const load = buildLoadPlan({ config, timestamps });
    expect(load.peakRps).toBe(2);
    expect(load.vus).toMatchObject({ preAllocatedVUs: 10, auto: true, assumedLatencyMs: 250 });
    expect(load.replayVus).toBe(10);
    expect(load.scenario).toEqual({
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 1,
      maxDuration: '40s',
      gracefulStop: '5s',
    });
    expect(load.offsets).toHaveLength(10);
    expect(load.plannedMs).toBe(4500);
    expect(load.loadEdges).toEqual([1, 2]);
    expect(load.loadTags).toEqual(['1', '2', '2', '2', '2', '2', '2', '2', '2', '2']);
  });

  it('replay: VUs grow with the peak and the probe latency', () => {
    const config = parseConfig({ PREFIX: 'http://h', RATIO: '100' });
    const burst = Array.from({ length: 400 }, (_, i) => i * 1000);
    expect(buildLoadPlan({ config, timestamps: burst }).vus.preAllocatedVUs).toBe(50);
    expect(buildLoadPlan({ config, timestamps: burst, probeLatencyMs: 1000 }).vus.preAllocatedVUs).toBe(200);
  });

  it('replay: explicit VUS override, never more VUs than requests', () => {
    const config = parseConfig({ PREFIX: 'http://h', VUS: '50' });
    const load = buildLoadPlan({ config, timestamps: [0, 1, 2] });
    expect(load.vus.auto).toBe(false);
    expect(load.scenario).toMatchObject({ vus: 3, iterations: 1 });
    expect(buildLoadPlan({ config, timestamps: [] }).scenario).toMatchObject({ vus: 1, iterations: 1 });
  });

  it('rate: constant-arrival-rate with explicit VUs', () => {
    const config = parseConfig({ PREFIX: 'http://h', MODE: 'rate', RPS: '25', DURATION: '2m', VUS: '10', MAX_VUS: '30' });
    const load = buildLoadPlan({ config, timestamps });
    expect(load.scenario).toEqual({
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 30,
      gracefulStop: '30s',
    });
    expect(load.peakRps).toBe(25);
    expect(load.plannedMs).toBeNull();
    expect(load.loadEdges).toEqual([25]);
    expect(load.loadTags).toEqual([]);
  });

  it('rate: auto VUs from RPS', () => {
    const config = parseConfig({ PREFIX: 'http://h', MODE: 'rate', RPS: '400' });
    expect(buildLoadPlan({ config, timestamps }).scenario).toMatchObject({ preAllocatedVUs: 200, maxVUs: 800 });
  });
});

describe('buildOptions', () => {
  it('assembles scenario, thresholds and global settings', () => {
    const config = parseConfig({ PREFIX: 'http://h', INSECURE: 'true', USER_AGENT: 'bench' });
    const load = buildLoadPlan({ config, timestamps: [0, 1] });
    const options = buildOptions({ config, load, topEndpoints: [{ endpoint: '/a', count: 2 }] });
    expect(Object.keys(options.scenarios as object)).toEqual([SCENARIO_NAME]);
    expect(options.thresholds).toHaveProperty('http_reqs{endpoint:/a}');
    expect(options.thresholds).toHaveProperty('http_req_duration{load:2}');
    expect(options.insecureSkipTLSVerify).toBe(true);
    expect(options.userAgent).toBe('bench');
    expect(options.summaryTrendStats).toContain('p(99.9)');
  });

  it('keeps the log user agent when USER_AGENT=log', () => {
    const config = parseConfig({ PREFIX: 'http://h' });
    expect(buildOptions({ config, load: buildLoadPlan({ config, timestamps: [0] }), topEndpoints: [] }).userAgent).toBeUndefined();
  });
});
