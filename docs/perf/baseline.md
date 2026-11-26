# Performance baseline (MVP-117, D-235)

Budgets: `docs/context/architecture.md#performance-budgets` and `quality-testing.md` (k6 row). Measured 2026-11-21 on the
dev laptop (16 cores; API, PostgreSQL 17 and k6 on the same machine), API built for production (`node dist/main.js`, one
process, Prisma's default pool of 10 connections).

## Results (p95 at 50 VUs, 60 s per scenario)

| Scenario | Budget | Before | After | |
|---|---|---|---|---|
| `GET /cases` (list, page 1–3, half `status=OPEN`) | 500 ms | 54.6 ms | 70.8 ms | ✓ |
| `GET /cases/:id` | 500 ms | 150.7 ms | 178.2 ms | ✓ |
| `GET /search?q=` (mix) | 200 ms | 8.11 s ¹ | 3.06 s → 104–139 ms ² | ✓ |
| — common words (in ~75% of the documents) | | 8.11 s | 3.33 s → 81–137 ms | |
| — rare words, file numbers | | — | 2.78 s → 125–139 ms | |
| `GET /dashboard` | 500 ms | 1.71 s | 208.6 ms | ✓ |
| `POST /documents` (10 KB PDF, 202 ack) | 2 s | 186.2 ms | 160.7 ms | ✓ |
| Errors | < 1% | 0.00% | 0.00% | ✓ |

¹ The first run searched common words only. ² MVP-172 (D-240): two-step search, both requests counted; see below.

The list and case-read code did not change between the runs: their differences (54.6 → 70.8 ms, 151 → 178 ms) are
run-to-run noise on a shared laptop. The upload gate is the k6 table's 2 s (`quality-testing.md`), tighter than the
5 s ack budget of `architecture.md`.

**Search at 10 VUs** (after): common words 265 ms, rare 71 ms, mix 238 ms p95. One common-word search costs ~200 ms of
database time (the document-text query, below); 50 of them a second saturate the database CPU, and rare searches queue
behind them. Follow-up story MVP-172: document search for common words (options: per-user cache, two-step search, an
ordered index, a bigger pool).

**After MVP-172 (D-240):** two-step search (`type=names`, then `type=documents` after a pause), documents and tasks read
the office's newest 1,000 rows first (`(office_id, id)` indexes: `Index Scan Backward` on 1,000 rows and a nested-loop
visibility check instead of matching 15k document vectors against a hash of the office's 20k documents), task visibility
bound to the office (no hashed scan of every office's files), and a pool of 20. Search at 50 VUs, warm: p95 **104–139 ms**
(common 81–137 ms, rare 125–139 ms; names step 119–166 ms, documents step 100–119 ms) ✓ — two warm runs; 195 ms on the first run after a
restart. Per query (`pg_stat_statements` mean under load): documents 18–22 ms, tasks 11–22 ms, files 7–8 ms, clients 2.6 ms;
plans in [top-queries](top-queries.md#after-mvp-172-d-240-the-newest-rows-window). `search-query.performance.int.spec.ts` still
passes (P95 6–73 ms).

Trade-off of the cap: for a word with more than 1,000 matches in the office, an older row that would rank higher is
not returned (nor added by the trigram pass); the newest matches are.

## Tuning

| Query | Before | After | Change |
|---|---|---|---|
| Dashboard quick-start: "has the office any document / file / client / hearing" | 50.7 ms seq scan (199,840 rows of other offices read) | 0.1 ms | `findFirst` ordered by the leading column of an existing `(officeId, …)` index |
| Dashboard recent activity (newest 20 events of my files) | 12.4 ms (sorts the office's 25k events) | 0.3 ms | index `case_timeline_events (office_id, occurred_at DESC, id DESC)` |
| Dashboard "new documents" count (last 7 days) | 13.1 ms | 5.2 ms | index `documents (office_id, created_at)` |
| Search, document text, common word | 498 ms (ranks 15,457 matches) | 170 ms | `searchQuery` ranks only the newest 1,000 matches |

Under load (`pg_stat_statements` mean of the 50-VU runs): document-text search 955 / 582 ms → 186 / 182 ms; dashboard
setup check on documents 75.9 ms → gone from the top list; recent activity 75.9 ms → 34.7 ms.

Tried and not kept: a `btree_gin` index on `document_texts (office_id, search_vector_*)` and a `document_texts (office_id,
id)` index — the planner kept scanning the office's rows (it cannot see the tsquery's selectivity at plan time).

Known limit: recent activity for a user with no files (an office manager) walks every event of the office — 60 ms on 25k
events; within budget now, worth a two-step query (the caller's files, then their events) once offices grow.

The top 10 queries and their plans: [top-queries.md](top-queries.md).

## Frontend

Production builds (`VITE_API_URL` set), gzip sizes from `pnpm perf:bundle`:

| App | First load (index.html) | Largest later chunk | Largest worker | Budget (CI) |
|---|---|---|---|---|
| office-app | 405.8 kB (674.5 kB before D-245) | 124.9 kB (`pdf`, the PDF viewer) | 367.3 kB (PDF.js) | 430 / 150 / 390 kB |
| client-portal | 389.8 kB | 26.8 kB (`FileDetailPage`) | — | 410 / 60 / 0 kB |
| admin-panel | 394.6 kB | 82.6 kB (`table`) | — | 415 / 100 / 0 kB |

Per app rather than per route: the largest later chunk bounds every route's own chunk.

The budgets guard against regressions; they are not the 4G target. Lighthouse 12.8 on the office app's `/login`
(`vite preview` of the production build):

| | Score | FCP | LCP (budget 2.5 s) | TBT | Transferred |
|---|---|---|---|---|---|
| Mobile, simulated slow 4G, 4× CPU | 0.47 | 6.7 s | **7.2 s** ✗ | 520 ms | 845 KiB |
| Desktop | 0.91 | 1.3 s | 1.4 s | 10 ms | |
| Mobile, after the shell split (D-245) | 0.58 | 4.7 s | **5.4 s** ✗ | 420 ms | 624 KiB |

Before D-245 the sign-in page loaded the whole shell: `index.html` preloaded the case list, client drawer, quick-create and
AntD table / date-picker chunks (321 KiB of unused JavaScript on `/login`). D-245 made the shell a lazy route and the route
table import feature `routes` files instead of barrels; the remaining gap to 2.5 s and the next levers are in D-245. The
authenticated pages were not measured: the production build talks to an https API only (staging).

## How to run

```bash
pnpm dev:up && pnpm perf:db                       # dev stack + the perf PostgreSQL (5435, pg_stat_statements)
docker exec nexlegtiq-postgres-perf-1 psql -U nexlegtiq -c "CREATE DATABASE nexlegtiq_perf"
docker exec nexlegtiq-postgres-perf-1 psql -U nexlegtiq -d nexlegtiq_perf -c "CREATE EXTENSION pg_stat_statements"
export PERF_DATABASE_URL=postgresql://nexlegtiq:nexlegtiq@127.0.0.1:5435/nexlegtiq_perf PERF_PASSWORD=<12+ characters>
DATABASE_URL=$PERF_DATABASE_URL pnpm nx run backend-api:prisma-deploy
NODE_ENV=development pnpm nx run backend-api:seed-perf        # ~5 min; PERF_OFFICES=2 for a quick one
pnpm nx run backend-api:build
# API on the perf database, listening for the k6 container, trusting its X-Forwarded-For (the rest of its variables
# from your .env: the dev stack's Redis, storage, mail):
set -a; . ./.env; set +a
DATABASE_URL=$PERF_DATABASE_URL TRUST_PROXY_HOPS=1 HOST=0.0.0.0 LOG_LEVEL=warn node apps/backend-api/dist/main.js
pnpm perf:k6                                      # all five scenarios, ~6 min; ONLY=search VUS=10 DURATION=30s to narrow
```

Query review: reset with
`SELECT pg_stat_statements_reset()` before a run, then read `pg_stat_statements` ordered by `total_exec_time`. Plans of the
real requests: `ALTER DATABASE nexlegtiq_perf SET session_preload_libraries = 'auto_explain'` plus
`auto_explain.log_min_duration = '15ms'` and `auto_explain.log_analyze = on`, restart the API, read
`docker logs nexlegtiq-postgres-perf-1`. Bundle sizes: build the apps, then `pnpm perf:bundle`. Lighthouse:
`npx lighthouse@12.8.2 http://localhost:4300/login --only-categories=performance` against `vite preview --port 4300`.
Remove the perf database: `docker compose -f docker/compose.dev.yml rm -sf postgres-perf` and
`docker volume rm nexlegtiq_pg-perf-data`.
