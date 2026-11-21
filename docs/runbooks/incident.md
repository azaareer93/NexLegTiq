# Incident runbook — monitoring, alerts, response (D-230)

Vendors (owner's choice on the monitoring story): **Sentry, EU region** (errors) and **Better Stack, EU region** (log sink,
uptime checks, status page, email + phone push). Metric alerts are rules in Better Stack over the API's
Prometheus `/metrics`, shipped by the Better Stack collector on the host. Nothing is sent anywhere until the accounts below
exist and their keys are set: the code is inert without them.

## Severity

| Severity | Examples | Respond | Update customers | Post-mortem |
|---|---|---|---|---|
| CRITICAL | app/portal down, data exposed across offices, data loss, login broken for everyone | 0–15 min | status page within 30 min, then hourly | within 24 h |
| HIGH | a core flow broken (documents, invoices, hearings), reminders not sent, error rate > 5 % | ≤ 1 h | status page if customers notice | within 24 h |
| MEDIUM | slow responses (P95 > 2 s), one queue backed up, a non-core feature down (AI, OCR) | ≤ 4 h | only if asked | optional |
| LOW | cosmetic bug, a single office's edge case | ≤ 2 days | — | — |

A suspected cross-office data leak is always CRITICAL and also starts the breach procedure (ops-security.md: notify
affected offices and regulators within 72 h, incident log).

## Alerts

Each rule lives in Better Stack; the threshold here is the source of truth.

| Alert | Rule (over `/metrics` unless noted) | Severity |
|---|---|---|
| API down | uptime check, 1 min: `GET https://<api>/health/ready` not 200 (503 = a dependency is down) | CRITICAL |
| Office app / portal down | uptime check, 1 min: the SPA's URL not 200 | CRITICAL |
| Error rate | `sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m])) > 0.05 and sum(rate(http_request_duration_seconds_count[5m])) > 0.2` for 5 min | HIGH |
| Slow API | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 2` for 5 min | MEDIUM |
| Queue backed up | `sum by (queue) (bullmq_queue_jobs{state=~"waiting\|prioritized"}) > 100` for 10 min | MEDIUM |
| Worker stalled | `sum by (queue) (bullmq_queue_jobs{state=~"waiting\|prioritized"}) > 0 and on (queue) bullmq_queue_jobs{state="active"} == 0` for 10 min | HIGH |
| Failed jobs spike | Sentry metric alert: > 20 events with a `queue` tag in 15 min | HIGH |
| Reminder failed | Sentry issue alert: any event tagged `queue:reminder` | HIGH |
| New error | Sentry issue alert: a new issue, or an issue seen > 10 times in 1 h | HIGH |
| SSL expiry | Better Stack uptime monitor's certificate check: < 30 days left, on the API, app and portal hosts | MEDIUM |
| Disk | collector host metrics (its host-metrics source enabled): disk use > 80 % | HIGH |
| AI cost | already built (D-144): daily email above `AI_COST_ALERT_THRESHOLD_USD` | MEDIUM |

Failed jobs alert through Sentry, not `/metrics`: the `failed` count is trimmed by the 30-day retention as new failures
arrive, so its level or delta cannot count new failures. Sentry gets exactly one event per job that failed its last
attempt. The worker has no `/metrics` of its own; a dead worker shows as "Worker stalled".

## Setup checklist (owner, once per environment)

1. **Sentry** — create the organisation in the **EU region** (`de.sentry.io`), one project `backend-api` (platform Node).
   Data scrubbing on (default), "Prevent storing of IP addresses" on. Copy the DSN.
2. **Backend env** — set `SENTRY_DSN`, `SENTRY_ENVIRONMENT` (`staging` / `production`) and `SENTRY_RELEASE` (the image tag)
   for the API and the worker. Staging renders `app.env` from GitHub environment secrets in the deploy workflow, so the
   three keys must be added there as well.
3. **Better Stack** — create the team in the **EU region**. Install the collector on the host (its one-line installer) with
   the source token: it ships the containers' JSON logs (Pino, with `reqId`/`requestId` for correlation) and host metrics
   (disk). Add a Prometheus scrape of the API container's `:9464/metrics` on the internal Docker network — the port is
   never published.
4. **Uptime monitors** (1 min, email + phone push): `/health/ready` of the API, the office app, the portal; SSL expiry
   alert at 30 days on each.
5. **Alert rules** — the table above.
6. **Status page** — on Better Stack's default subdomain until the domain is bought (D-103), then `status.<domain>`;
   before paid launch.
7. **Legal** — Sentry and Better Stack become sub-processors the day step 2 or 3 is done: the sub-processor list and the
   privacy text must name them (EU region) first.
8. **Test** — fire each alert once and keep the evidence (screenshots) with the setup: stop the worker container and enqueue
   a job (worker stalled), point a monitor at a 404, `curl` a route that throws on staging, fail a reminder job.

## What error reports contain (D-230)

Only unexpected 5xx request failures (not SYS-002 outages, which the uptime check covers) and jobs that failed their last
attempt are reported: the error type, its stack frames, the message only for our own `AppException`s, plus tags: error
code, status, request id, queue, job name, job id, attempt, Prisma code. Never request bodies, headers, cookies, query
strings, tokens, users, job payloads, document text, or the message of a library error (they quote their input). The scrub is in `apps/backend-api/src/common/monitoring/error-reporting.ts`.

## During an incident

1. Acknowledge the alert (Better Stack), set the severity from the table.
2. Find the request: the error's `requestId` tag → search the logs for it (`reqId` on HTTP lines, `requestId` on job lines).
3. CRITICAL/HIGH visible to customers → post on the status page (template below).
4. Fix or roll back (deploy.md: redeploy the previous image tag). Restores: restore-db.md, restore-documents.md.
5. Resolve the incident on the status page; write the post-mortem for CRITICAL/HIGH within 24 h.

### Status page update (AR / EN)

> **جارٍ التحقيق** — نواجه مشكلة في {الخدمة} منذ {الوقت}. بياناتكم آمنة. سنوافيكم بالتحديث خلال {المدة}.
>
> **Investigating** — {service} has been failing since {time}. Your data is safe. Next update within {interval}.

> **تم الحل** — عادت {الخدمة} للعمل منذ {الوقت}. السبب: {سبب مختصر}. نعتذر عن الإزعاج.
>
> **Resolved** — {service} has worked again since {time}. Cause: {short cause}. We are sorry for the trouble.

### Post-mortem

```
Incident: <title>            Severity: <…>        Date: <YYYY-MM-DD>
Impact:   who was affected, for how long, what they could not do, any data affected
Timeline: detected (how) → acknowledged → mitigated → resolved, times in UTC
Cause:    the root cause, not the trigger
Fix:      what stopped it; what prevents it next time (tickets)
Detection: did an alert fire first? If a customer told us, which alert was missing?
```
