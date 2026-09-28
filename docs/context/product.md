# Product Context

> Distilled from Notion (Root, Roadmap, Business Strategy, Personas, RICE, FAQ, ToS). Conflicts resolved in
> `decisions.md`. Source links: `00-index.md`.

## What NexLegTiq is
An AI-native, bilingual (Arabic/English, RTL/LTR) workspace for law offices in MENA — case files, court
hearings and reminders, documents with OCR, tasks, billing, and AI assistance — built multi-tenant from day one.
Launch market **Palestine** (~500+ lawyers, ~95% paper-based, mixed legal system: Ottoman, British Mandate,
Jordanian, Egyptian, Palestinian law), then Jordan, Egypt, GCC, and global English-speaking firms.
Built and run by a **solo founder** — favour boring, low-ops, well-tested choices.

Positioning: "the only bilingual AI legal workspace built for MENA". Competitors: Clio, MyCase,
PracticePanther, Smokeball, Lawmatics (practice mgmt, English-first); Harvey, CoCounsel (AI, no practice mgmt,
expensive); Lexis/Westlaw Gulf (research).

## Personas (who we optimize for)
| Persona | Role in app | Language | Must-haves |
|---|---|---|---|
| Solo practitioner (35–50, PS/JO/EG/GCC) | OFFICE_MANAGER of a 1-person office | Arabic | Cases, hearing reminders, documents, simple invoicing; cheap |
| Managing partner (3–20 lawyers) | OFFICE_MANAGER | Bilingual | Dashboard, team, reports, billing, ROI |
| Senior associate | SENIOR_LAWYER | English | AI summarization, (Phase 2: contract analysis, templates) |
| Paralegal | PARALEGAL | Arabic | Documents, tasks |
| Client of the office | ClientUser (portal) | Arabic | "What's happening with my case?", shared docs, invoices |

Secondary: government legal advisors (security/audit, RFPs), corporate legal departments, academics.

## MVP scope
Decision D-002: Phase 1 foundation + AI summarization + Client Portal. Target: beta with 5–10 Palestinian firms.

| # | Capability | Notes |
|---|---|---|
| 1 | Multi-tenant offices, signup (freemium), login, RBAC (7 roles), invites, password reset | `auth-rbac.md` |
| 2 | Bilingual UI (AR default / EN), RTL, AntD theme, keyboard shortcuts | `frontend.md` |
| 3 | Clients (+contact persons, 360 view) | |
| 4 | Legal files (cases): CRUD, numbering, parties, conflict-of-interest check, team, timeline, close/reopen/archive, task templates | Heart of the product |
| 5 | Courts & judges (global reference + office-owned), sessions/hearings, conflict check, reminders 7/3/1 days (email + in-app), calendar | RICE #1 & #3 |
| 6 | Documents: upload, folders, versions, secure download, OCR (Tesseract ara+eng; Google Vision fallback for Arabic scans/handwriting) | |
| 7 | Tasks: per file, Kanban, templates, due reminders | |
| 8 | Global search (Arabic-aware FTS) across files, clients, parties, documents (incl. OCR text), tasks | |
| 9 | AI: document summarization + session-minutes summary with next steps → tasks; per-case "Ask AI" limited to summaries in MVP; quotas per plan; disclaimers; PII redaction | `ai-ocr.md` |
| 10 | Client Portal (read-mostly) | D-003 |
| 11 | Billing basic: time entries, timer, invoices (per file or consolidated per client), PDF, mark paid | |
| 12 | Dashboard (role-aware KPIs), in-app notifications (WebSocket), activity feed | |
| 13 | Audit log (per file + office), ToS/privacy acceptance, office data export | |
| 14 | Onboarding wizard (8 steps, skippable) | |
| 15 | Platform admin panel: tenants, plans, manual subscriptions (cash/bank), usage | |

Explicitly **not** MVP: contract analysis, evidence suggestions, similar cases, AI drafting/templates generation,
local court process tracker, email ingestion, voice notes, calendar sync (Google/Outlook), SMS/WhatsApp,
online payments, reports beyond dashboard, public API/webhooks, SSO/MFA for all users (MFA for platform admins
IS in MVP), mobile apps, multi-office login.

## Success metrics
- Create first case < 2 min; onboarding < 5 min; onboarding completion > 70%.
- Case page load < 500 ms (API P95 < 500 ms), page load < 2 s.
- D7 retention > 40%, D30 > 20%; freemium → paid > 10%.
- Year-1: 30 paying customers, $36K ARR. MVP live month 6, first 10 firms month 9, first paid month 10.

## Pricing (data, not code — D-005)
Palestine: Free 6 months (≤5 users, AI 5/mo) → Starter $29 (5 users, AI 50/mo) → Professional $69 (10 users,
AI unlimited) → Enterprise $129+. Global: Solo $49 (1), Small Firm $99 (3), Professional $199 (10), Enterprise custom;
30-day trial. Annual −20%. Discounts: non-profit 15%, education 20%, founder 10% (first 50), referral 10%.
Payments at MVP: manual (cash / bank transfer) recorded in admin panel.

## Roadmap after MVP
- **Phase 2 — Intelligence:** contract analysis vs jurisdiction, evidence suggestions, similar cases (pgvector),
  bilingual templates + merge fields, local court process tracker (PS/JO/EG first), email ingestion, voice notes,
  calendar sync, portal messaging.
- **Phase 3 — Scale:** reports & analytics, statute-of-limitations deadlines, saved searches, trust accounting,
  Arabic NLP/OCR improvements, RLS hardening, mobile (React Native).
- **Phase 4 — Ecosystem:** public API + API keys, webhooks, e-signature, payments (Stripe, PayTabs, Tabby,
  PayPal), SMS/WhatsApp, template marketplace, white-label.
- **Phase 5 — Enterprise:** multi-office single login, SSO/SAML/SCIM, MFA everywhere, custom roles,
  no-code workflows, compliance packs, full data export tooling.

## Legal/compliance promises we must honor in product
- Show ToS + Privacy acceptance at signup; store accepted versions (D-038).
- AI outputs "as is" with visible disclaimers; human oversight; customer data never used for training.
- Data export on request/cancellation; account deletion after 30-day grace; closed cases retained 5 years.
- Sub-processors listed in DPA must match what we actually use (update before launch — D-021).
- 18+ users; breach notification ≤ 72h.
