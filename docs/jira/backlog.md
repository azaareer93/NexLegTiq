# Jira backlog map — project MVP

Board: https://nexlegtiq.atlassian.net/jira/software/projects/MVP/boards/2 · created 2026-09-28 from `docs/context/`.
Kanban has no sprints — **slices** (labels `slice-1`…`slice-5`) are the ordered delivery batches. Work top-down within a slice,
respecting "Blocks" links. `/standup` recommends the next unblocked ticket.

## Delivery slices
| Slice | Goal | Stories |
|---|---|---|
| **slice-1 — Foundation** | Monorepo, CI, backend core, tenancy, RBAC, auth, i18n/RTL shell | MVP-28 → 36, MVP-37 → 42, MVP-43 → 46, MVP-120 |
| **slice-2 — Core case work** | Office/team, clients, legal files, parties, courts, hearings + reminders, audit service, staging | MVP-48 → 50, 52 · 53 → 54 · 56 → 63 · 66 → 69 · 104 · 111 |
| **slice-3 — Documents & daily flow** | Documents + OCR, tasks, search, notifications, dashboard, calendar, lifecycle, demo data | MVP-47, 51, 55, 64, 65, 70 · 71 → 82 · 94 → 96 · 118 |
| **slice-4 — AI, billing, portal, admin** | AI summaries, billing, client portal, admin panel, audit UI, onboarding | MVP-83 → 93 · 97 → 102 · 105 · 108 → 109 |
| **slice-5 — Launch readiness** | Prod, backups, monitoring, E2E, security, perf, export/deletion, legal alignment, help center | MVP-103, 106, 107, 110, 112 → 117, 119 |

Suggested first ticket: **MVP-28** (scaffold) → then MVP-30, MVP-32, MVP-33, MVP-37 in that order (backend critical path);
MVP-43/44 can run in parallel on the frontend once MVP-28 lands.

## Epics
| Epic | Key | Phase |
|---|---|---|
| Platform Foundation & DevEx | MVP-4 | 1 |
| Auth, RBAC & Multi-Tenancy | MVP-5 | 1 |
| Office, Team & Subscriptions | MVP-6 | 1 |
| Design System, App Shell & AR/EN Localization | MVP-7 | 1 |
| Clients | MVP-8 | 1 |
| Legal Files (Case Management) | MVP-9 | 1 |
| Courts, Hearings & Reminders | MVP-10 | 1 |
| Documents & OCR | MVP-11 | 1 |
| Tasks | MVP-12 | 1 |
| Global Search (Arabic-aware) | MVP-13 | 1 |
| AI Summarization (Documents & Sessions) | MVP-14 | 1 |
| Billing: Time Tracking & Invoices | MVP-15 | 1 |
| Dashboard, Notifications & Realtime | MVP-16 | 1 |
| Client Portal | MVP-17 | 1 |
| Platform Admin Panel | MVP-18 | 1 |
| Audit, Privacy & Compliance | MVP-19 | 1 |
| Onboarding & First-Run Experience | MVP-20 | 1 |
| Launch Readiness | MVP-21 | 1 |
| Legal Intelligence (contract analysis, evidence, similar cases) | MVP-22 | 2 |
| Bilingual Templates & Local Court Process Tracker | MVP-23 | 2 |
| Email Ingestion, Voice Notes, Calendar Sync & Portal Messaging | MVP-24 | 2 |
| Reports, Deadlines & Scale Hardening | MVP-25 | 3 |
| Public API, Webhooks, Payments & Messaging Integrations | MVP-26 | 4 |
| Enterprise: Multi-Office, SSO/SCIM, MFA, Custom Roles | MVP-27 | 5 |

## Stories by epic
- **MVP-4 Foundation:** 28 scaffold · 29 tooling · 30 dev stack · 31 CI · 32 backend core · 33 Prisma base · 34 queues · 35 storage & email · 36 api-client
- **MVP-5 Auth:** 37 tenant isolation · 38 RBAC · 39 signup · 40 login/refresh/lockout · 41 password reset · 42 auth UI
- **MVP-6 Office:** 48 settings · 49 invites · 50 team mgmt · 51 plan limits · 52 profile
- **MVP-7 Design/i18n:** 43 tokens & shared-ui · 44 i18n infra · 45 shell · 46 formatting · 47 shortcuts · 120 error/UX states
- **MVP-8 Clients:** 53 API · 54 UI · 55 profile 360
- **MVP-9 Legal files:** 56 model & numbering · 57 API · 58 list · 59 quick-create · 60 file page · 61 clients & team · 62 parties & conflicts · 63 timeline · 64 lifecycle · 65 notes & witnesses
- **MVP-10 Hearings:** 66 courts seed · 67 sessions API · 68 reminder engine · 69 sessions tab · 70 calendar
- **MVP-11 Documents:** 71 model & folders · 72 upload · 73 OCR worker · 74 access/download · 75 documents tab
- **MVP-12 Tasks:** 76 API · 77 UI · 78 templates · 79 reminders
- **MVP-13 Search:** 80 FTS infra · 81 API · 82 overlay
- **MVP-14 AI:** 83 foundation · 84 PII redactor · 85 quotas & cost · 86 document summary · 87 session summary · 88 AI UI · 89 evals
- **MVP-15 Billing:** 90 time · 91 invoices API · 92 invoice PDF · 93 billing UI
- **MVP-16 Dashboard:** 94 realtime · 95 notifications · 96 dashboard
- **MVP-17 Portal:** 97 portal auth · 98 portal API & sharing · 99 client uploads · 100 portal UI
- **MVP-18 Admin:** 101 admin auth + MFA · 102 offices/plans/payments · 103 usage & health
- **MVP-19 Audit/Privacy:** 104 audit service · 105 audit UI · 106 export & deletion · 107 legal docs alignment (task, needs-decision)
- **MVP-20 Onboarding:** 108 wizard · 109 empty states · 110 analytics
- **MVP-21 Launch:** 111 staging + CD · 112 production release · 113 backups · 114 monitoring · 115 E2E · 116 security testing · 117 performance · 118 demo data · 119 help center

Slice-1 subtasks: MVP-121 → 140 (under 28, 30, 32, 33, 37, 38, 40, 44).
MVP-3 ("Subtask 2.1") is a pre-existing placeholder unrelated to this backlog — delete or ignore.
