# Legal facts register (what the legal texts may promise)

> The ToS, Privacy Policy, DPA and FAQ live in Notion ([ToS & Privacy](https://app.notion.com/p/399fd30cf06d80d1a65dc70010a39fc7) ·
> [DPA](https://app.notion.com/p/399fd30cf06d80d8b428d358f34f1bab) · [FAQ](https://app.notion.com/p/399fd30cf06d807da129e80d5f431fd5)).
> This file is the engineering side: what the code and infra **actually do**, checked against the repo (D-220).
> A legal text may promise only what is listed here as **Fact**. Rows marked **Pending owner** are not settled; the
> legal texts must not state them as facts until the owner decides and this file is updated. Change this file in the
> same PR as any code change that alters one of these facts, and bump `LEGAL_VERSIONS` when a published text changes.

## 1. Data region (D-021)

| Item | Status |
|---|---|
| Customer data (database, Redis, document storage, backups) is hosted **in the EU** — Germany or Finland | **Owner commitment** (D-021, Jira comment 2026-11-10 — no provider is contracted yet) — the FAQ's "AWS us-east-1" is wrong and must go |
| The exact providers and country (VPS, managed Postgres, managed Redis, object storage, backup bucket) | **Pending owner** — nothing in the repo names one yet (`docs/runbooks/deploy.md`, `infra/staging/`); the legal text says "EU (Germany or Finland)" until they are contracted |
| Static web apps (office app, portal, admin panel) are served by **Cloudflare Pages** (a global CDN — static files only, no customer data) | Fact (D-020, `ops-security.md`) |
| AI text providers (OpenAI, Google Gemini) process redacted text **outside the EU** (their API endpoints are not EU-pinned: `api.openai.com`, `generativelanguage.googleapis.com`) | Fact — the transfer and its safeguard must be disclosed; **pending owner** (see §5) |
| Google Vision (opt-in OCR) is called on the **EU endpoint** `eu-vision.googleapis.com` **by default**; production only refuses hosts outside `https://*.googleapis.com`, so a global or US endpoint is possible by configuration | Fact (D-142, `GOOGLE_VISION_ENDPOINT`); the text may say "EU endpoint" only while the deployment keeps the default |

## 2. Sub-processors actually used by the code

Only these. Anything else on the current DPA/FAQ list (AWS, Supabase, Upstash, SendGrid, Stripe, PayPal) is **not used**
and must be removed, or named only once it is contracted.

| Sub-processor (category) | Data it receives | When | Status |
|---|---|---|---|
| VPS host (API + worker containers) | everything the app processes | always | Category fact; **provider pending owner** (EU) |
| Managed PostgreSQL 17 | all office data (encrypted storage is a provider requirement); sensitive ids also AES-256-GCM in the app (D-056) | always | Category fact; **provider pending owner** (EU) |
| Managed Redis | queue jobs (ids, not documents), AI answers cache (office's own data, 24 h), WebSocket fan-out | always | Category fact; **provider pending owner** (EU) |
| S3-compatible object storage | uploaded documents, office exports | always | Category fact; **provider pending owner** (EU) |
| Backup bucket at a **second** provider | `age`-encrypted database dumps and a copy of documents (D-141) | once `BACKUP_ENABLED` | Category fact; **provider pending owner** (EU) |
| Email delivery: SMTP relay **or Resend** (`EMAIL_PROVIDER`) | recipient address, name, the email's text and links | always | Fact (code supports exactly these two); **which one pending owner** |
| **OpenAI** (API) | PII-pseudonymized text of documents/hearings (§3) | only when AI is configured, in the plan and on for the office | Use: Fact (code sends `store: false`). Zero retention: **pending owner** — an account agreement with OpenAI (owner 7A, 2026-11-10) |
| **Google Gemini** (API, paid account) | the same pseudonymized text, as primary or fallback provider | as above | Use: Fact. Paid account excluding training: **owner commitment** (7A) — nothing in the code enforces it |
| **Google Cloud Vision** | **unredacted scan images** (scans cannot be redacted) | only offices that switch on `enableVisionOcr` (default off), on a plan with the `googleVisionOcr` flag and a page budget; never documents **the office has marked confidential** (no automatic detection) | Fact (D-142; owner 7A: listed as "only for offices that switch it on") |
| Cloudflare Pages | none (static files; visitors' IP addresses in its logs) | always | Fact |
| Error monitoring (Sentry), uptime monitor, log sink | — | **not integrated yet** (no SDK in the code) | Listed only when the monitoring story ships |
| Payment processors | — | **none**: payments are recorded by hand with numbered receipts (D-174) | Card/wallet processors are Phase 4 |

Not sub-processors (run inside our own containers): ClamAV (upload scanning), Tesseract (OCR), Chromium (PDFs).

## 3. AI data handling (D-057, D-131, D-142)

- **Pseudonymized, not anonymized.** Before any LLM call, `PiiRedactor` replaces emails, phones, IBANs, card/bank numbers,
  national ids and the names of the file's clients, parties, witnesses and lawyers with placeholders, and restores them
  in the answer. The mapping stays in the job's memory only. Known limits: names the file does not list (a judge, a
  third person) are not found — there is no NER. **The Privacy Policy's "anonymized" must become "pseudonymized
  (identifying details replaced before sending)"**; "anonymized" over-promises.
- OpenAI requests are sent with `store: false`. Zero data retention beyond that is an **account-level agreement with
  OpenAI** — the owner must have it in place before the text claims "zero retention" (owner 7A).
- Gemini only on a **paid** Google account (its terms exclude training on API data). Owner to keep the account paid.
- Customer data is never used to train models: we train none, and both providers' API terms above exclude it.
- AI is on by default for an office (`enableAi` default true) but only works when the platform configured a provider and
  the plan includes it; an office can switch it off (AI-005). Every AI output carries a disclaimer; a human confirms.
- Stored with each AI output: provider, model, prompt version; `AiUsage` keeps token counts, cost and redaction **counts**
  (never the redacted values).
- Google Vision receives the page images themselves (unredacted), only under the opt-in above; the transfer disclosure
  (§1, pending owner) covers Vision as well as the text providers.

## 4. Retention — implemented vs promised

| Data | What the code does today | Legal text may say |
|---|---|---|
| Audit log | Daily purge of rows older than the office's `auditRetentionDays` (default and minimum 365) — D-060, D-136 | Fact: 365 days by default, longer if the office sets it |
| Notifications | Deleted after 90 days (D-149) | Fact |
| Queue jobs (Redis) | Completed: 7 days / last 1000; failed: 30 days | Fact |
| AI answer cache (Redis) | 24 h (`AI_CACHE_TTL`) | Fact |
| Office export ZIP | Downloadable for 7 days; the file itself is **not deleted yet** (bucket lifecycle rule planned, D-184) | "available for 7 days" — not "deleted after 7 days" until the lifecycle rule exists |
| Backups | weekly/ 90 days, monthly/ 365 days, deleted documents' copies 90 days — by bucket lifecycle (D-141) | Fact once backups are enabled; **pending owner** (`BACKUP_ENABLED`, provider) |
| Soft-deleted documents | Hidden at once; stored objects stay — **no purge job exists yet** | **Pending owner**: no deletion period may be promised yet |
| Time entries 3 y, invoices 6 y, closed cases 5 y then review | **Not implemented** — nothing deletes or flags them; data stays while the account exists | **Pending owner** (legal periods to confirm); until then: "kept for the life of the account" |
| Office deletion (D-251) | An office manager asks (password + MFA code); the office is read-only for 30 days, any office manager can cancel, and platform staff bring the date forward only on the office's written request. Then every row and stored object of the office is deleted, except issued invoices (kept as issued) and the anonymized audit log for `RETAINED_RECORDS_YEARS` (default 7), and our own subscription/payment records | Fact: "deleted 30 days after the request, unless cancelled". Retention of invoices and the anonymized log: **pending legal confirmation** of the 7 years (Palestine, Jordan) |
| Data export | Office ZIP and per-user JSON export exist (D-184) | Fact |

## 5. Legal acceptance & versions

- Office signup and invitation acceptance store ToS + Privacy `LegalAcceptance` rows with the version in
  `LEGAL_VERSIONS` (`apps/backend-api/src/modules/auth/signup.repository.ts`, currently `2026-09-28`, D-083). Portal
  invitations record the versions in the audit row (D-158).
- **Not implemented:** re-acceptance on next login after a version bump, and pages at `/legal/terms` and
  `/legal/privacy` — the signup page, invitation page and every email footer link there, but no app or site serves them
  yet. **Pending owner:** where the versioned texts are hosted (see the Jira comment on the ticket).
- Case studies are illustrative (D-007): never presented as real customers.

## 6. Corrections the Notion texts need (owner to apply — legal wording)

1. FAQ/DPA: replace "AWS us-east-1" with "the EU (Germany or Finland)".
2. DPA/FAQ sub-processor list: replace with §2 (drop AWS, Supabase, Upstash, SendGrid, Stripe, PayPal; add the
   categories with "provider to be named before launch"; Google Vision only for offices that opt in).
3. Privacy Policy: "anonymized" → "pseudonymized" (§3); disclose that AI providers process the redacted text outside the
   EU, and the safeguard (pending owner, §1).
4. Retention promises: only the "Fact" rows of §4; mark the rest as described there.
5. Case studies page: "illustrative" (D-007).
