# nginx-logs-replay

Replay real nginx access logs against an HTTP server with [k6](https://k6.io)
and see where the time goes: per endpoint, and per backend component when the
server returns a `debug` block in its JSON responses (mongo, clickhouse,
redis, …).

Two scripts, no daemon:

- `src/discover.ts` — probes the target, learns the shape of the `debug`
  block, writes `debug-schema.json`.
- `src/replay.ts` — replays the log (timeline or fixed RPS), prints a
  component/endpoint breakdown, writes `summary.json` and a self-contained
  `summary.html` (charts, full percentiles, per-endpoint and per-component
  tables).

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

# 2. replay the log twice as fast as it happened (VUs are sized automatically)
k6 run -e PREFIX=https://api.example.com -e LOG=./access.log -e RATIO=2 src/replay.ts

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
| `VUS` | auto | concurrent VUs; empty = busiest second of the plan × latency measured by `discover.ts` (min 250ms) × 2 |
| `MAX_VUS` | auto | rate mode: hard cap on VUs (default 4 × VUS, at least 200); k6 adds VUs on demand up to it |
| `FORMAT` | nginx `combined` | your `log_format` string with `$vars` (must contain `$request` and `$time_local` or `$msec`) |
| `START_TS` | `0` | skip entries before this unix timestamp (seconds) |
| `LIMIT` | `0` | use at most N entries (0 = all) |
| `FILTER_ONLY` | | comma-separated substrings; keep only matching requests |
| `FILTER_SKIP` | | comma-separated substrings; drop matching requests |
| `SKIP_STATUSES` | | drop log entries by original status: codes or masks, e.g. `429,5xx` or `50*` (requests production rejected or failed) |
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
| `SUMMARY_HTML` | `./summary.html` | HTML report (inline CSS/SVG, no JS); empty disables |
| `HISTORY` | | JSON file with earlier runs (read at start, this run appended at the end); enables the RATIO bisection across runs |
| `RUN_LABEL` | | free-text label stored with the run in HISTORY (Jenkins passes the build name) |
| `DASHBOARD_HREF` | | link to the k6 dashboard export shown in the HTML report |
| `NO_COLOR` | | disable ANSI colors |

## How the load is generated

**replay** — every request gets an absolute target time
`start + (t_log - t_first) / RATIO`. Requests logged in the same second are
spread evenly across that second, so 1-second log granularity does not turn
into bursts (with `$msec` in the log format offsets are exact). VUs are sized
automatically from the busiest second of the plan and the latency measured by
`discover.ts`; `VUS` overrides. If a request is late because all VUs were busy,
`replay_lag_ms` records by how much and the summary suggests a `VUS` value.

**rate** — k6 `constant-arrival-rate`: exactly `RPS` requests per second,
walking through the pool in order and wrapping around.

Both modes replay the method, path, query and user agent from the log.
Status codes from the log are compared with the replayed ones
(`replay_status_mismatch`, broken down by log → replay pair in the summary).
A log full of 429/406 means production rejected those requests at the rate
limiter; replaying them hits the backend harder than production did, so use
`SKIP_STATUSES=429,5xx` for a faithful load. 4xx are normal replayed answers;
only 5xx and transport errors count as failed.

## Finding the fastest RATIO

The goal is the RATIO at which the whole log replays fastest. While the target
keeps up, the run finishes on schedule (`log span / RATIO`) and RATIO can go
up. Once the target caps, requests queue, the run overruns its plan and the
achieved rps stops growing; a higher RATIO only makes latency worse.

With `HISTORY` set (the Jenkins jobs keep it next to the cached log), every
replay of the same log / target / query setup is recorded and the report
bisects: the fastest on-schedule ratio is the lower bound, the lowest ratio
that overran its plan is the upper bound, the suggestion is their geometric
mean, and once they are within 15% the report declares the optimum. Throughput
measured under overload is deliberately not used as a capacity estimate: with
queues and timeouts it is lower than what the target sustains just below the
cap (e.g. 242 rps at x101 vs 286 rps at x67.5 on the same log).

Without history the summary falls back to the single-run rule:

- on schedule (overrun ≤ 10%, median lag < 1s): `Suggested next run: RATIO × 1.5`;
- on schedule but bursts already queue (median lag ≥ 1s): `RATIO × 1.2`;
- overran the plan by more than 10% or dropped requests: the target capped at
  the achieved rps, and the fastest full replay is
  `achieved rps ÷ average log rps × 0.95`, printed as the suggestion.

As a secondary hint, every request is tagged with the load it was fired at
(requests due in the same wall-clock second) and the summary shows latency by
load in 8 buckets up to the busiest second (buckets need ≥100 requests and 2%
of the run; "climbing" = p95 above 2× the best bucket + 200ms, or >1% failed).
The point where latency starts climbing is reported as `~xN`: past it requests
get slower, but the full replay still finishes sooner until the cap. Rate mode
compares the run with the discover probe latency and suggests the next `RPS`.

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
`summary.html` is the same report with bar charts (latency percentiles,
components by p95, endpoints by latency and volume) and full tables; pair it
with the k6 dashboard export (`K6_WEB_DASHBOARD_EXPORT`) for time series.

Stopping a run early (Ctrl+C, SIGTERM, `docker stop`) still produces the
summary: k6 finishes in-flight requests and runs `handleSummary`.

## Development

```bash
npm ci
npm run check        # typecheck + unit tests + e2e (e2e needs k6, skips otherwise)
```

See `CLAUDE.md` for the code layout and rules.

## Jenkins

One `Jenkinsfile` serves two jobs whose parameters are defined in the devops
job DSL (`terraform/modules/jenkins/jobs/root/scripts/`):

- `scripts/nginx-logs-replay` — log timeline, parameter `RATIO`;
- `scripts/nginx-logs-rate` — fixed rate, parameters `RPS` and `DURATION`.

Both take `FILE` (log upload, plain or `.gz`; empty = the last log uploaded on
that agent is reused, or the `examples/access.log` smoke sample if there is
none), `PREFIX`, `VUS`, `QUERY_PARAMS` (default
`debugId=clickhouse&noJokes=please`) and extra `-e` options in `EXTRA_ENV`.
The cache buster and `DEBUG_TIME_UNIT=s` are always on. The pipeline builds the Docker image, runs `discover.ts`, then
`replay.ts`, and archives `summary.json`, `report.html`, `debug-schema.json`.
