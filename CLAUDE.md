# nginx-logs-replay

Replay nginx access logs with k6 and report where the time goes: per endpoint
and per backend component (from the `debug` block of JSON responses).
"Just a script": `k6 run src/replay.ts`. No orchestrator, no REST API.

Design spec: `docs/superpowers/specs/2026-09-09-k6-rewrite-design.md`.
Legacy v1 (axios) is tagged `legacy-v1` on `main`.

## Layout

```
src/replay.ts        k6 entry: load model, request loop, handleSummary
src/discover.ts      k6 entry: probes the target, writes debug-schema.json
src/lib/             PURE modules (no k6 imports) — unit tested with vitest
  config.ts          __ENV -> Config, validation (ConfigError lists all problems)
  nginx-parser.ts    log_format string -> regex, $time_local/$msec parsing
  request-pool.ts    filters, sorting, URL building, endpoint normalization
  schedule.ts        replay offsets (intra-second spreading), VU partitioning
  debug-walker.ts    debug object -> samples, schema discovery, metric names
  options.ts         k6 options object (scenarios, per-endpoint thresholds)
  summary.ts         k6 summary data -> Report model -> text
  format.ts          tables, number/duration formatting, ANSI palette
src/k6/              k6 glue (the ONLY place besides entries importing k6/*)
  pool.ts            SharedArray loading, schema file loading
  metrics.ts         custom metrics declared from the schema
  request.ts         one request: URL, headers, tags, mismatch + debug samples
test/unit/           vitest, one file per lib module
test/e2e/            mock server + real k6 runs (skips when k6 is missing)
examples/            sample access.log and debug-schema.example.json
```

## Rules

- **k6 imports only in `src/replay.ts`, `src/discover.ts`, `src/k6/*`.**
  Everything in `src/lib/` must run in Node (vitest) and in k6's runtime:
  no `URL`, no named capture groups, no Node APIs.
- k6 custom metrics must be declared in the init context. That is why the
  debug schema is discovered up front (`discover.ts`) and read at init.
- Metric names must match `^[a-zA-Z_][a-zA-Z0-9_]{0,127}$` (`metricName()`).
- Keep modules pure and small; new logic goes into `src/lib/` with a test.
- Immutability: return new objects, do not mutate inputs.
- Code, comments, commits, PRs: English.

## Commands

```bash
npm ci
npm run typecheck          # tsc --noEmit (k6 + node types)
npm test                   # vitest unit tests
npm run test:e2e           # mock server + k6 (needs k6 on PATH or K6_BIN)
npm run check              # all three

# discover the debug schema, then replay
k6 run -e PREFIX=https://host -e LOG=access.log src/discover.ts
k6 run -e PREFIX=https://host -e LOG=access.log -e RATIO=2 src/replay.ts
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=report.html k6 run ... src/replay.ts
```

k6 is not an npm dependency. Install the binary (https://grafana.com/docs/k6/latest/set-up/install-k6/)
or use the Docker image built from `Dockerfile` (based on `grafana/k6`).

## Verifying a change

1. `npm run check` must pass (unit + typecheck + e2e).
2. For anything touching `src/k6/*` or the entries, run the e2e; unit tests
   cannot see k6 runtime differences (e.g. `SharedArray` element access).
3. Compare a `summary.json` before/after when changing `summary.ts`.
