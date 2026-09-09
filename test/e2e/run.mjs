// End-to-end: mock server + real k6 running discover.ts and replay.ts in both
// modes against examples/access.log. Skips (exit 0) when k6 is not installed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG = path.join(root, 'examples', 'access.log');
const POOL_SIZE = 20; // valid lines in examples/access.log (one line is malformed)

function findK6() {
  const candidates = [process.env.K6_BIN, 'k6', path.join(process.env.HOME ?? '', '.local', 'bin', 'k6')].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'test', 'e2e', 'mock-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', (chunk) => resolve({ child, port: JSON.parse(String(chunk)).port }));
    child.once('error', reject);
  });
}

function runK6(k6, script, env, cwd) {
  const args = ['run', '--quiet', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), script];
  const result = spawnSync(k6, args, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  process.stdout.write(result.stdout);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${path.basename(script)} exited with ${result.status}`);
  }
  return result;
}

async function stats(port) {
  const res = await fetch(`http://127.0.0.1:${port}/__stats`);
  return res.json();
}

async function main() {
  const k6 = findK6();
  if (!k6) {
    console.log('e2e: k6 binary not found, skipping (set K6_BIN or install k6)');
    return;
  }
  const work = mkdtempSync(path.join(tmpdir(), 'nginx-logs-replay-e2e-'));
  const { child, port } = await startServer();
  const prefix = `http://127.0.0.1:${port}`;
  const schemaPath = path.join(work, 'debug-schema.json');
  const summaryPath = path.join(work, 'summary.json');
  const htmlPath = path.join(work, 'summary.html');
  const common = { PREFIX: prefix, LOG, DEBUG_SCHEMA: schemaPath, SUMMARY_JSON: summaryPath, SUMMARY_HTML: htmlPath, NO_COLOR: '1' };
  try {
    console.log('e2e: discover');
    runK6(k6, path.join(root, 'src', 'discover.ts'), { ...common, DISCOVER_N: '3' }, root);
    assert.ok(existsSync(schemaPath), 'schema file written');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const metrics = schema.entries.map((e) => e.metric);
    assert.ok(metrics.includes('dbg_clickhouse_time'), 'clickhouse time discovered');
    assert.ok(metrics.includes('dbg_clickhouse_getTxs_time'), 'clickhouse query discovered');
    assert.ok(metrics.includes('dbg_mongo_read_num'), 'mongo num discovered');
    assert.ok(metrics.includes('dbg_memory_peak'), 'memory peak discovered');

    console.log('e2e: replay mode');
    const before = (await stats(port)).count;
    runK6(k6, path.join(root, 'src', 'replay.ts'), { ...common, RATIO: '5', VUS: '5', CACHE_BUSTER: 'cb', QUERY_PARAMS: 'apiKey=e2e' }, root);
    const replay = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.equal(replay.report.header.poolKept, POOL_SIZE);
    assert.equal(replay.report.header.malformed, 1);
    assert.equal(replay.report.http.count, POOL_SIZE);
    assert.equal(replay.report.http.mismatches, 1, 'only /nodebug (404 in log, 200 served) mismatches');
    assert.deepEqual(replay.report.http.mismatchPairs, [{ from: 404, to: 200, count: 1 }], 'mismatch pair recorded');
    assert.ok(replay.report.http.failedRate > 0 && replay.report.http.failedRate < 0.1, '/fail counted as failed');
    assert.equal(replay.report.debug.missing, 3, '/fail, /nodebug and /html have no debug block');
    assert.equal(replay.report.debug.unknownPaths, 0);
    const byPath = Object.fromEntries(replay.report.components.map((r) => [r.path, r]));
    assert.ok(byPath.clickhouse.time.p95 > 0 && byPath.clickhouse.num === 17, 'clickhouse row aggregated');
    assert.ok(byPath['mongo.read'].num === 34, 'mongo num summed');
    assert.equal(replay.report.components[0].path, 'totalTime', 'totalTime is the slowest "component"');
    assert.ok(replay.report.endpoints.length >= 5, 'per-endpoint rows present');
    const slow = replay.report.endpoints.find((e) => e.endpoint === '/slow');
    assert.ok(slow && slow.count === 2 && slow.duration.p50 >= 200 && slow.rps > 0, '/slow endpoint measured');
    const nodebug = replay.report.endpoints.find((e) => e.endpoint === '/nodebug');
    assert.ok(nodebug && nodebug.mismatches === 1, 'per-endpoint mismatch counted');
    assert.ok(replay.report.http.dataReceived > 0 && replay.report.http.ttfb.p95 > 0, 'traffic and ttfb present');
    assert.ok(replay.report.header.logFrom.startsWith('2026-09-10T12:00:00'), 'log window present');
    assert.ok(replay.report.http.lagP95 !== null && replay.report.http.lagP95 < 500, 'schedule lag is small');
    assert.ok(replay.report.header.vusAuto === false && replay.report.header.vus === 5, 'explicit VUS honoured');
    assert.ok(typeof schema.probe.avgDurationMs === 'number' && schema.probe.avgDurationMs > 0, 'discover stored probe latency');
    const html = readFileSync(htmlPath, 'utf8');
    assert.ok(html.startsWith('<!DOCTYPE html>') && html.includes('<svg') && html.includes('clickhouse') && html.includes('/slow'), 'HTML report written');
    const received = (await stats(port)).received.slice(before);
    assert.equal(received.length, POOL_SIZE);
    assert.ok(received.every((r) => r.url.includes('cb=')), 'cache buster on every request');
    assert.ok(received.every((r) => !r.url.includes('apiKey=freekey')), 'apiKey overridden');
    assert.ok(received.some((r) => r.ua === 'curl/8.0'), 'user agent replayed from log');
    assert.ok(received.some((r) => r.method === 'POST'), 'method replayed from log');

    console.log('e2e: skip statuses');
    runK6(k6, path.join(root, 'src', 'replay.ts'), { ...common, RATIO: '10', SKIP_STATUSES: '404,500' }, root);
    const skipped = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.equal(skipped.report.header.poolKept, POOL_SIZE - 2, '/nodebug (404) and /fail (500) skipped');
    assert.equal(skipped.report.http.mismatches, 0);

    console.log('e2e: rate mode');
    runK6(k6, path.join(root, 'src', 'replay.ts'), { ...common, MODE: 'rate', RPS: '20', DURATION: '2s' }, root);
    const rate = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.ok(rate.report.http.count >= 30 && rate.report.http.count <= 45, `rate mode sent ~40 requests, got ${rate.report.http.count}`);
    assert.equal(rate.report.http.lagP95, null, 'no lag metric in rate mode');
    assert.ok(rate.report.header.vusAuto === true && rate.report.header.vus === 10 && rate.report.header.maxVus === 200, 'rate mode auto VUs');
    assert.ok(rate.report.components.length > 0);

    console.log('e2e: OK');
  } finally {
    child.kill('SIGTERM');
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
