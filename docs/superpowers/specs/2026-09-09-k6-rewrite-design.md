# nginx-logs-replay v2 — k6 rewrite design

Date: 2026-09-09
Branch: `feature/k6-rewrite`
Status: approved in chat ("делай оптимально"), no REST API / orchestrator.

## Goal

Replay real nginx access logs (or a fixed request rate built from them) against a
target HTTP server and report where the time goes — per endpoint and, when the
server returns a `debug` block in its JSON body, per backend component
(mongo, clickhouse, redis, …). Live metrics come from k6 itself (web dashboard,
optional Prometheus remote write); the end-of-test console summary is custom.

Non-goals: request generators, cache-key logic for a specific service, any
long-running orchestrator. The tool is "just a script": `k6 run src/replay.ts`.

## Runtime

- k6 ≥ 2.x with native TypeScript (esbuild type stripping). Entry scripts and
  the metrics module are the only files that import `k6/*`.
- Node ≥ 20 only for development: vitest unit tests, typecheck, e2e mock server.
- Docker image based on `grafana/k6` for Jenkins.

## Layout

```
src/
  replay.ts            k6 entry: options, default fn, handleSummary
  discover.ts          k6 entry: probes N requests, writes debug-schema.json
  lib/                 PURE modules, no k6 imports, unit tested
    config.ts          __ENV -> typed Config, validation, defaults
    nginx-parser.ts    log_format string -> regex; line -> LogEntry; $time_local/$msec
    request-pool.ts    filters, LIMIT, query overrides, cache buster, URL build, endpoint normalization
    schedule.ts        replay offsets (intra-second spreading, ratio), VU partition
    debug-walker.ts    walk debug object -> samples; schema discovery; name sanitizing
    options.ts         k6 options object: scenarios + per-endpoint thresholds
    summary.ts         handleSummary data -> report model -> text
    format.ts          text tables, colors
  k6/                  k6 glue (SharedArray, metrics, http)
    pool.ts            log -> SharedArray once; schema file loading
    metrics.ts         declare Trend/Counter per schema entry; record samples
    request.ts         one request: URL, headers, tags, mismatch + debug samples
test/unit/             vitest, one file per lib module
test/e2e/              mock server + real k6 (discover, replay, rate)
examples/              sample access.log, debug-schema.example.json
```

## Configuration (`-e KEY=value`)

| Key | Default | Meaning |
|-----|---------|---------|
| `PREFIX` | required | Base URL, e.g. `https://api.example.com` |
| `LOG` | `./access.log` | nginx log file (plain text; gunzip before) |
| `MODE` | `replay` | `replay` (timeline from log) or `rate` (fixed RPS from pool) |
| `RATIO` | `1` | replay speed multiplier (2 = twice as fast) |
| `RPS` | `10` | rate mode: requests per second |
| `DURATION` | `60s` | rate mode: test duration |
| `VUS` | `50` | replay: max concurrency; rate: preAllocatedVUs |
| `MAX_VUS` | `VUS*4` | rate mode: hard VU cap |
| `FORMAT` | nginx combined | nginx `log_format` string with `$vars` |
| `START_TS` | `0` | skip log entries before this unix timestamp (s) |
| `LIMIT` | `0` | take at most N entries (0 = all) |
| `FILTER_ONLY` | `` | comma-separated substrings; keep only matching requests |
| `FILTER_SKIP` | `` | comma-separated substrings; drop matching requests |
| `QUERY_PARAMS` | `` | `a=1&b=2` — set/override query params on every request |
| `CACHE_BUSTER` | `` | query param name; value unique per request when set |
| `TIMEOUT` | `30s` | per-request timeout |
| `INSECURE` | `false` | skip TLS verification |
| `AUTH` | `` | `user:pass` basic auth |
| `USER_AGENT` | `log` | `log` = replay UA from log, or a literal string |
| `ENDPOINT_NORMALIZE` | `true` | `/x/0xabc…` -> `/x/:hex` (also `:n`, `:uuid`, `:hash`) for the `endpoint` tag |
| `DISCOVER_N` | `5` | discover: requests to probe |
| `DEBUG_FIELD` | `debug` | dotted path to the debug object in the JSON body |
| `DEBUG_SCHEMA` | `./debug-schema.json` | schema produced by `discover.ts`; missing file = no component metrics |
| `TOP` | `15` | endpoints shown in summary / given per-endpoint sub-metrics |
| `SUMMARY_JSON` | `./summary.json` | machine-readable summary path |

Validation fails fast in init with one clear message per problem.

## Request pool

`nginx-parser` compiles the `FORMAT` string into a regex (each `$var` becomes a
named group; `$request` is split into method/path/protocol). `$time_local` is
parsed with a fixed month map (no date library); `$msec` when present gives
millisecond precision. Malformed lines are counted and skipped, not fatal.

`request-pool` applies `START_TS`, `FILTER_ONLY/SKIP`, `LIMIT`, and produces a
compact array `{ m, p, ts, st, ua }` stored in a k6 `SharedArray` (parsed once,
shared across VUs).

URL building per request: `PREFIX + path`, then `QUERY_PARAMS` overrides, then
`CACHE_BUSTER=<vu>-<iter>-<ms>` if configured. Method from log; no body.

## Load model

**replay** — executor `per-vu-iterations`, `vus = VUS`,
`iterations = ceil(N / VUS)`, `maxDuration = span/RATIO + TIMEOUT + 30s`.
VU `v` at iteration `i` handles pool index `i*VUS + (v-1)`. `schedule.ts`
precomputes an offset (ms) per index: `(ts - ts0)` plus even spreading inside
each 1-second bucket (`k/count * 1000`) so 1s-granularity logs do not burst.
Target time = `exec.scenario.startTime + offset/RATIO`; the VU sleeps until
then, or fires immediately if late and records `replay_lag_ms`. Absolute
scheduling means no cumulative drift.

**rate** — executor `constant-arrival-rate` with `rate = RPS`,
`duration = DURATION`, `preAllocatedVUs = VUS`, `maxVUs = MAX_VUS`.
Pool index = `exec.scenario.iterationInTest % N` (wraps around).

Both tag every request with `endpoint` (path without query, ids normalized
to `:hex`/`:n`/`:uuid`/`:hash` unless `ENDPOINT_NORMALIZE=false`) and
`name` = endpoint so k6 groups URLs sensibly.

## Metrics

Built-in k6 HTTP metrics plus:

| Metric | Type | Meaning |
|--------|------|---------|
| `replay_lag_ms` | Trend | how late a replayed request fired vs schedule |
| `replay_status_mismatch` | Counter | replayed status != status in log |
| `http_req_failed` | Rate | built-in, with `expectedStatuses(200..499)`: only 5xx / transport errors fail |
| `debug_missing` | Counter | responses with no parsable debug block |
| `debug_unknown_paths` | Counter | debug paths not in schema (listed in summary) |
| `dbg_<path>_time` | Trend | component time, per schema entry |
| `dbg_<path>_num` | Counter | component query count, per schema entry |
| `dbg_<path>_usage` / `_peak` | Trend | memory-style entries |

Per-endpoint sub-metrics for the `TOP` most frequent endpoints are surfaced in
the summary by declaring always-passing thresholds
(`http_req_duration{endpoint:/x}: ['max>=0']`).

### Debug walker rules (kept from v1)

For each `(field, value)` in the debug object:
- object with `time` / `num` / `queries`: emit `time`, `num`, and one `time`
  per `queries.<name>`;
- object with `usage`: emit `usage` and `peak`;
- other object: recurse with `parent.field` prefix;
- number: emit `time`.

Metric names: path with non-`[a-zA-Z0-9_]` replaced by `_`, prefixed `dbg_`,
truncated to 128 chars. Because k6 metrics must exist at init, the schema is
discovered once by `discover.ts` (probes the first `DISCOVER_N=5` pool entries
in `setup()`, unions the paths, writes `DEBUG_SCHEMA` from `handleSummary` via
`setup_data`). `replay.ts` reads the schema in init and declares metrics.
Paths seen at runtime but absent from the schema increment
`debug_unknown_paths` and are listed at the end so a changed backend is
visible.

## Live output

Provided by k6, no custom code:
- `K6_WEB_DASHBOARD=true` — live dashboard at :5665, `K6_WEB_DASHBOARD_EXPORT=report.html` for an artifact;
- `-o experimental-prometheus-rw` + `K6_PROMETHEUS_RW_SERVER_URL` — Grafana; all custom metrics carry the `endpoint` tag.

## End-of-test summary

`handleSummary` → `summary.ts` builds a report model from `data.metrics`, and
`format.ts` renders it:

1. Header: mode, prefix, pool size, original span & rps vs achieved rps, VUs.
2. HTTP: count, fail %, status mismatches, p50/p95/p99/max, lag p95 (replay).
3. Components: one row per schema entry with samples, sorted by p95 desc:
   `avg  p95  p99  max  num`. This is the "who is slow" table.
4. Endpoints (top `TOP` by count): count, fail %, p50/p95/max.
5. Debug: missing count, unknown paths list.

Also written: `SUMMARY_JSON` with the raw k6 summary plus the report model.
`summaryTrendStats` = `avg,min,med,p(90),p(95),p(99),max`.

## Error handling

- Config errors: throw in init with the full list of problems.
- Log parse errors: counted, reported in header; zero valid lines = fatal.
- Non-JSON or missing debug: `debug_missing++`, request still measured.
- Transport errors and 5xx: k6 `http_req_failed`.

## Testing

- vitest unit tests for every pure module (parser formats, msec, schedule
  spreading/ratio/partition, filters, cache buster, walker rules, name
  sanitizing, summary model from a fixture, config validation).
- e2e: `test/e2e/mock-server.mjs` (Node, returns JSON with a debug block and
  configurable latency) + `k6 run` of `discover.ts` then `replay.ts` in both
  modes against a sample log; asserts summary.json contents. Skipped when k6
  is not on PATH.
- CI (GitHub Actions): `npm ci`, `npm run typecheck`, `npm test`, e2e with the
  official k6 setup action; Docker build on `main`.

## Delivery

- `Dockerfile` on `grafana/k6`, `Jenkinsfile` parametrized (FILE upload, PREFIX,
  MODE, RATIO, RPS, VUS, DURATION, EXTRA_ENV), archives `summary.json` and
  `report.html`.
- `CLAUDE.md` describing layout, rules (k6 imports only in entries/metrics,
  pure libs tested), commands.
- `README.md` rewritten for v2, v1 documented as `legacy` git tag.
