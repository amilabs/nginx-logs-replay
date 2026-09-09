// Minimal target for e2e runs: JSON responses with a debug block, a few
// special paths, and a /__stats endpoint listing what was received.
import http from 'node:http';

const port = Number(process.env.PORT ?? 0);
const received = [];

const jitter = (base) => base + Math.random() * base * 0.5;

function debugBlock(latencyMs) {
  const clickhouse = jitter(latencyMs * 0.5);
  return {
    totalTime: latencyMs,
    requestID: 'e2e',
    mongo: { read: { time: jitter(latencyMs * 0.2), num: 2 } },
    clickhouse: { time: clickhouse, num: 1, queries: { getTxs: clickhouse } },
    redis: { read: { time: jitter(0.5), num: 3 } },
    memory: { usage: 1024, peak: 2048 },
  };
}

function route(url) {
  const path = url.split('?')[0];
  if (path === '/slow') return { status: 200, latency: 200, body: (l) => ({ data: [], debug: debugBlock(l) }) };
  if (path === '/fail') return { status: 500, latency: 5, body: () => ({ error: 'boom' }) };
  if (path === '/nodebug') return { status: 200, latency: 5, body: () => ({ data: [1, 2, 3] }) };
  if (path === '/html') return { status: 200, latency: 5, html: true };
  return { status: 200, latency: 20, body: (l) => ({ data: [{ id: 1 }], debug: debugBlock(l) }) };
}

const server = http.createServer((req, res) => {
  if (req.url === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: received.length, received }));
    return;
  }
  received.push({ method: req.method, url: req.url, ua: req.headers['user-agent'] ?? '' });
  const r = route(req.url ?? '/');
  setTimeout(() => {
    if (r.html) {
      res.writeHead(r.status, { 'content-type': 'text/html' });
      res.end('<html><body>hi</body></html>');
      return;
    }
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body(r.latency)));
  }, r.latency);
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
