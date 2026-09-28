# Key Workflows & Business Rules

> Source: "COMPREHENSIVE WORKFLOWS", Flow Charts, Onboarding. Use for acceptance criteria and E2E journeys.

- **W1 Signup** — office + OFFICE_MANAGER + subscription (PS freemium / global trial) + settings + default folders/task templates;
  welcome email; empty-state dashboard with quick-start checklist.
- **W2 Invite** — OM invites (email, role, message) → email link (7d) → accept (name, password, phone) → user active → OM notified.
  Plan user limit enforced at invite and accept (`BIZ-008`).
- **W3/W7 OM dashboard & oversight** — office totals, revenue this month, top lawyers by billable hours, hearings this week, overdue tasks,
  activity; OM/SL see all files; every action audited.
- **W4 Settings** — reminder days, default billing rate/method, jurisdiction, enable AI/OCR, file-number format; new files/users inherit.
- **W5 Subscription & deactivate** — upgrade/downgrade via admin (manual payments in MVP); deactivation requires reassigning open files.
- **W6 Create file** — type/subtype, title, client (search or inline), responsible lawyer (default self) → number generated
  (`{YEAR}-{TYPE}-{SEQ}`), timeline `FILE_OPENED`, tasks auto-created from TaskTemplates for the file type (due = open + N days).
  Target: < 2 minutes for a first-time user.
- **W8 Lawyer scope** — LAWYER/PARALEGAL/TRAINEE/X see assigned files only; SL sees all.
- **W9 Conflict check** — adding a party: search office parties (name/nationalId/taxId fuzzy) → if the party is on another file on an
  adverse side (or is that file's client) → create ConflictOfInterest + warning modal: proceed with note / cancel / reassign.
- **W10 Invoicing** — select client (+ optional file) and period → unbilled billable time entries → Draft invoice with line items + tax →
  send (email PDF, optionally share to portal) → mark paid. Consolidated per client when `fileId` null.
- **Hearing lifecycle** — create (conflict check same lawyer overlapping → 409 unless acknowledged) → reminders at 7/3/1 days (email + in-app,
  to attending + responsible lawyer) → reschedule moves reminders → after hearing: outcome + minutes (+ optional next session) →
  optional AI summary + next steps → user converts next steps to tasks.
- **Document lifecycle** — upload → scan → OCR/extract → READY (searchable) → optional AI summary → versions (new upload with change note) →
  share with client (portal) → download (audited).
- **Close / reopen / archive** — close requires no open tasks (or forced with reason), sets closingDate, cancels reminders; reopen resets;
  archive (manual or 30 days after close if office opts in) = read-only but searchable.
- **Reassign** — change responsible lawyer → notify both, tasks stay, timeline + audit.
- **Client portal** — lawyer invites client contact (email) from client profile → client sets password → sees linked files' status,
  next hearing (date/court only), public timeline events (opened, hearing scheduled, document shared, invoice sent), shared documents,
  invoices; can upload documents into CLIENT_UPLOADS (quarantined until a lawyer accepts).
- **Tasks** — Kanban per file and "My tasks"; due reminders (1 day before + overdue daily digest); completion adds timeline event.
- **Search** — Ctrl+K, ≥ 2 chars, 300 ms debounce, grouped (files, clients, parties, documents incl. OCR text, tasks), scoped to what the
  user may see; Arabic normalization.
