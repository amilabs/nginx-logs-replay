# nginx-logs-replay

Replay real nginx access logs against an HTTP server with [k6](https://k6.io)
and see where the time goes: per endpoint, and per backend component when the
server returns a `debug` block in its JSON responses (mongo, clickhouse,
redis, …).

Two scripts, no daemon:

- `src/discover.ts` — probes the target, learns the shape of the `debug`
  block, writes `debug-schema.json`.
- `src/replay.ts` — replays the log (timeline or fixed RPS), prints a
  component/endpoint breakdown, writes `summary.json`.

Live metrics come from k6 itself: the built-in web dashboard and, optionally,
Prometheus remote write for Grafana.

> v1 (Node/axios) lives on the `legacy-v1` tag.

## Requirements

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) ≥ 1.0 (TypeScript is transpiled by k6 itself).
- Node ≥ 20 only for development (tests, typecheck).
- Or Docker: `docker build -t nginx-logs-replay .`

## Quick start

```bash
# 1. learn the debug block (5 requests by default) -> ./debug-schema.json
k6 run -e PREFIX=https://api.example.com -e LOG=./access.log src/discover.ts

# 2. replay the log twice as fast as it happened, 100 concurrent requests max
k6 run -e PREFIX=https://api.example.com -e LOG=./access.log -e RATIO=2 -e VUS=100 src/replay.ts

# 3. or fire the same requests at a fixed 50 rps for 5 minutes
k6 run -e PREFIX=https://api.example.com -e LOG=./access.log -e MODE=rate -e RPS=50 -e DURATION=5m src/replay.ts
```

Gzipped logs: `gunzip -c access.log.gz > access.log` first (k6 reads plain files).

### Live view

```bash
# web dashboard on http://127.0.0.1:5665 + self-contained HTML report at the end
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=report.html k6 run -e PREFIX=... src/replay.ts

# Grafana via Prometheus remote write (every metric carries the `endpoint` tag)
K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),max' \
k6 run -o experimental-prometheus-rw --tag testid=eth3-$(date +%s) -e PREFIX=... src/replay.ts
```

## Options (`-e KEY=value`)

| Key | Default | Meaning |
|-----|---------|---------|
| `PREFIX` | required | Base URL, e.g. `https://api.example.com` |
| `LOG` | `./access.log` | nginx access log (plain text) |
| `MODE` | `replay` | `replay` = follow the log timeline, `rate` = fixed RPS from the same requests |
| `RATIO` | `1` | replay speed: `2` = twice as fast, `0.5` = half speed |
| `RPS` | `10` | rate mode: requests per second |
| `DURATION` | `60s` | rate mode: how long to run |
| `VUS` | `50` | replay: max concurrent requests; rate: pre-allocated VUs |
| `MAX_VUS` | `VUS*4` | rate mode: hard cap on VUs |
| `FORMAT` | nginx `combined` | your `log_format` string with `$vars` (must contain `$request` and `$time_local` or `$msec`) |
| `START_TS` | `0` | skip entries before this unix timestamp (seconds) |
| `LIMIT` | `0` | use at most N entries (0 = all) |
| `FILTER_ONLY` | | comma-separated substrings; keep only matching requests |
| `FILTER_SKIP` | | comma-separated substrings; drop matching requests |
| `QUERY_PARAMS` | | `apiKey=x&debug=1` — set/override query params on every request |
| `CACHE_BUSTER` | | query param name; gets a unique value per request (bypass caches) |
| `TIMEOUT` | `30s` | per-request timeout |
| `INSECURE` | `false` | skip TLS verification |
| `AUTH` | | `user:password` basic auth |
| `USER_AGENT` | `log` | replay the UA from the log, or a literal string |
| `ENDPOINT_NORMALIZE` | `true` | group `/x/0xabc…` as `/x/:hex` (also `:n`, `:uuid`, `:hash`) |
| `DEBUG_FIELD` | `debug` | dotted path to the debug object in the JSON body |
| `DEBUG_TIME_UNIT` | `ms` | unit of `time` values in the debug block: `ms`, `s` or `us` (reported in ms) |
| `DEBUG_SCHEMA` | `./debug-schema.json` | schema from `discover.ts`; missing file = no component metrics; `none` disables |
| `DISCOVER_N` | `5` | discover: how many requests to probe |
| `TOP` | `15` | endpoints shown in the summary |
| `SUMMARY_JSON` | `./summary.json` | machine-readable summary |
| `NO_COLOR` | | disable ANSI colors |

## How the load is generated

**replay** — every request gets an absolute target time
`start + (t_log - t_first) / RATIO`. Requests logged in the same second are
spread evenly across that second, so 1-second log granularity does not turn
into bursts. `VUS` bounds concurrency; if a request is late because all VUs
were busy, `replay_lag_ms` records by how much (the summary warns when p95
lag exceeds 1s: raise `VUS` or lower `RATIO`).

**rate** — k6 `constant-arrival-rate`: exactly `RPS` requests per second,
walking through the pool in order and wrapping around.

Both modes replay the method, path, query and user agent from the log.
Status codes from the log are compared with the replayed ones
(`replay_status_mismatch`). 4xx are normal replayed answers; only 5xx and
transport errors count as failed.

## Component metrics (the "who is slow" table)

If responses are JSON with a debug block like

```json
{ "debug": { "totalTime": 123, "mongo": { "read": { "time": 10, "num": 3 } },
             "clickhouse": { "time": 80, "num": 2, "queries": { "getTxs": 50 } },
             "memory": { "usage": 1024, "peak": 2048 } } }
```

`discover.ts` turns it into a schema and `replay.ts` records one k6 metric per
entry (`dbg_clickhouse_time`, `dbg_clickhouse_num`, `dbg_clickhouse_getTxs_time`,
`dbg_memory_usage`, …), each tagged with `endpoint`. Rules:

- object with `time` / `num` / `queries` → time, num, and time per query;
- object with `usage` → usage and peak;
- other object → recurse (`mongo.read`);
- bare number → time.

Paths that appear at runtime but are not in the schema are counted in
`debug_unknown_paths` and logged once; re-run `discover.ts` when the backend
changes. Responses without a debug block count in `debug_missing`.

## Summary

```
nginx-logs-replay  mode=replay  target=https://api.example.com
pool:      20 of 21 log entries, 1 malformed lines skipped
original:  5.0s span, 4 rps
load:      ratio x5 (target 20 rps), max 5 VUs
achieved:  20 requests in 1.4s, 14.76 rps

HTTP
requests 20   failed (5xx/transport) 5.00%   status != log 1
duration avg 36.4ms  p50 20.6ms  p95 200ms  p99 201ms  max 201ms
schedule lag p95 0.00ms  max 0.00ms

COMPONENTS (sorted by p95, time from the debug block)
component             avg     p95     p99     max  num  mem avg  mem peak
-----------------  ------  ------  ------  ------  ---  -------  --------
totalTime          41.2ms   200ms   200ms   200ms    -        -         -
clickhouse         25.5ms   117ms   126ms   129ms   17        -         -
mongo.read         10.0ms  44.3ms  52.9ms  55.0ms   34        -         -
...

ENDPOINTS (top 15 by count)
endpoint                      count   failed     p50     p95     max
----------------------------  -----  -------  ------  ------  ------
/getAddressInfo/:hex              5    0.00%  20.6ms  20.8ms  20.9ms
/slow                             2    0.00%   200ms   201ms   201ms
```

`summary.json` contains the same report model plus the raw k6 summary.

## Development

```bash
npm ci
npm run check        # typecheck + unit tests + e2e (e2e needs k6, skips otherwise)
```

See `CLAUDE.md` for the code layout and rules.

## Jenkins

`Jenkinsfile` runs the Docker image: upload a log (plain or `.gz`), set
`PREFIX`, `MODE`, `RATIO`/`RPS`, `VUS`, `DURATION`, extra `-e` options in
`EXTRA_ENV`. Artifacts: `summary.json`, `report.html`, `debug-schema.json`.
