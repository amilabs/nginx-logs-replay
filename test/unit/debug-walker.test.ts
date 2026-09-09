import { describe, expect, it } from 'vitest';
import {
  discoverSchema,
  getByPath,
  metricCollisions,
  metricName,
  parseSchema,
  scaleTimeSamples,
  walkDebug,
} from '../../src/lib/debug-walker.ts';

const DEBUG = {
  totalTime: 123.4,
  requestID: 'abc',
  mongo: {
    read: { time: 10, num: 3 },
    write: { time: 0, num: 0 },
  },
  clickhouse: { time: 80, num: 2, queries: { getTxs: 50, getOps: 30 } },
  redis: { read: { time: 1.5, num: 7 } },
  memory: { usage: 1024, peak: 2048 },
  search: { search: 'foo', nested: { deep: { time: 4 } } },
  list: [1, 2, 3],
  nothing: null,
};

describe('walkDebug', () => {
  it('applies the v1 rules', () => {
    const samples = walkDebug(DEBUG);
    expect(samples).toEqual([
      { path: 'totalTime', kind: 'time', value: 123.4 },
      { path: 'mongo.read', kind: 'time', value: 10 },
      { path: 'mongo.read', kind: 'num', value: 3 },
      { path: 'mongo.write', kind: 'time', value: 0 },
      { path: 'mongo.write', kind: 'num', value: 0 },
      { path: 'clickhouse', kind: 'time', value: 80 },
      { path: 'clickhouse', kind: 'num', value: 2 },
      { path: 'clickhouse.getTxs', kind: 'time', value: 50 },
      { path: 'clickhouse.getOps', kind: 'time', value: 30 },
      { path: 'redis.read', kind: 'time', value: 1.5 },
      { path: 'redis.read', kind: 'num', value: 7 },
      { path: 'memory', kind: 'usage', value: 1024 },
      { path: 'memory', kind: 'peak', value: 2048 },
      { path: 'search.nested.deep', kind: 'time', value: 4 },
    ]);
  });

  it('ignores non-objects', () => {
    expect(walkDebug(null)).toEqual([]);
    expect(walkDebug('x')).toEqual([]);
    expect(walkDebug([1])).toEqual([]);
  });
});

describe('scaleTimeSamples', () => {
  it('scales only time samples', () => {
    const samples = walkDebug({ clickhouse: { time: 0.05, num: 2 }, memory: { usage: 10, peak: 20 } });
    expect(scaleTimeSamples(samples, 1000)).toEqual([
      { path: 'clickhouse', kind: 'time', value: 50 },
      { path: 'clickhouse', kind: 'num', value: 2 },
      { path: 'memory', kind: 'usage', value: 10 },
      { path: 'memory', kind: 'peak', value: 20 },
    ]);
    expect(scaleTimeSamples(samples, 1)).toEqual(samples);
  });
});

describe('metricName', () => {
  it('sanitizes to a valid k6 metric name', () => {
    expect(metricName('mongo.read', 'time')).toBe('dbg_mongo_read_time');
    expect(metricName('clickhouse.get-txs v2', 'num')).toBe('dbg_clickhouse_get_txs_v2_num');
    expect(metricName('x'.repeat(200), 'time')).toHaveLength(128);
  });
});

describe('getByPath', () => {
  it('reads dotted paths', () => {
    expect(getByPath({ data: { debug: { a: 1 } } }, 'data.debug')).toEqual({ a: 1 });
    expect(getByPath({ debug: 1 }, 'debug')).toBe(1);
    expect(getByPath({ debug: 1 }, 'debug.a')).toBeUndefined();
    expect(getByPath(null, 'debug')).toBeUndefined();
  });
});

describe('discoverSchema / parseSchema', () => {
  it('unions probes into a sorted schema', () => {
    const schema = discoverSchema('debug', [walkDebug({ b: { time: 1 } }), walkDebug({ a: 2, b: { time: 3, num: 1 } })]);
    expect(schema).toEqual({
      field: 'debug',
      entries: [
        { path: 'a', kind: 'time', metric: 'dbg_a_time' },
        { path: 'b', kind: 'num', metric: 'dbg_b_num' },
        { path: 'b', kind: 'time', metric: 'dbg_b_time' },
      ],
    });
  });

  it('round-trips through JSON and rejects bad shapes', () => {
    const schema = discoverSchema('debug', [walkDebug(DEBUG)]);
    expect(parseSchema(JSON.parse(JSON.stringify(schema)))).toEqual(schema);
    expect(parseSchema({ ...JSON.parse(JSON.stringify(schema)), probe: { avgDurationMs: 65.5 } })).toEqual({ ...schema, probeAvgMs: 65.5 });
    expect(parseSchema({ field: 'debug' })).toBeNull();
    expect(parseSchema({ field: 'debug', entries: [{ path: 'a', kind: 'weird' }] })).toBeNull();
    expect(parseSchema('nope')).toBeNull();
  });

  it('reports metric name collisions', () => {
    const schema = discoverSchema('debug', [walkDebug({ 'a-b': 1, a_b: 2 })]);
    const collisions = metricCollisions(schema);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatch(/^dbg_a_b_time <- a[-_]b#time, a[-_]b#time$/);
    expect(metricCollisions(discoverSchema('debug', [walkDebug({ a: 1 })]))).toEqual([]);
  });
});
