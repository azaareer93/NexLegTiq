# Frontend: UX, Design System, i18n & RTL

> Source: "Complete UI/UX Experience", "Ant Design for NexLegTiq", "Arabic Localization Guide", Onboarding Flow.

## Theme (AntD 6 tokens — `nexTheme()` in `packages/shared-ui/src/theme/theme.ts`)
colorPrimary `#1a3c6e` (hover `#2a5a9c`, bg `#e6edf5`) · success `#2e7d32` · warning `#ed6c02` · error `#d32f2f` · info `#0288d1`
colorBgBase `#ffffff` · page background (AntD `colorBgLayout`) `#f8f9fa`, inputs/cards stay white · colorTextBase `#1a2332` · colorTextSecondary `#5a6a7e` · colorBorder `#d9e1ec`
fontSize 14 · headings 28/24/20/18/16 · borderRadius 8 (LG 12, SM 4) · controlHeight 40 (LG 48, SM 32)
boxShadow `0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)` · boxShadowSecondary `0 4px 12px rgba(0,0,0,.08)`
Fonts (self-hosted, D-088): EN `Inter`; AR UI `IBM Plex Sans Arabic` (Inter first in the stack, so Latin and digits match);
documents/PDF `Amiri`. Theme: `nexTheme(locale)` via `NexProvider` (shared-ui). Arabic: +1px size, line-height 1.8. Dark mode: token algorithm switch, Phase 2.

## i18n & RTL rules (non-negotiable)
- i18next + react-i18next; namespaces per feature; **no hard-coded user-facing strings** (lint: `i18next/no-literal-string`
  in `apps/*/src`). Arabic is MSA (fusha), formal. Legal glossary in `glossary.md` — always use it.
- `<html lang dir>` + AntD `ConfigProvider direction/locale` + dayjs locale switch together (`LanguageProvider` /
  `useLanguage` in shared-ui; keys `<namespace>.<key>` from `@nexlegtiq/shared-i18n`, typed, AR/EN parity checked in CI: D-087).
- CSS logical properties only (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`);
  stylelint rule bans physical `left/right` props. Directional icons mirrored in RTL.
- Numbers, emails, URLs, file numbers, phone numbers render LTR inside RTL (`<bdi>` / `dir="ltr"` + `unicode-bidi: isolate`).
- Western digits by default; Arabic-Indic digits optional per user setting. Dates `dd/MM/yyyy`; times with ص/م in AR.
- No fixed widths for text (Arabic +20–30%). Test every screen in both directions (Storybook RTL toggle, Cypress both locales).
- Default language: Arabic for PS/JO/EG offices unless office/user says otherwise.

## Shell
Header: logo + office name, global search (Ctrl+K, grouped results), notifications bell (unread count), profile menu
(profile, language toggle, logout). Collapsible Sider (mirrors in RTL): Dashboard, My Cases, Clients, Calendar, Tasks,
Documents, Reports (OM/SL/A), Team (OM), Settings (OM). Quick actions: + File, + Client, + Task, AI Ask.
Breakpoints: ≥1200 full; 768–1199 icon sider; <768 bottom nav, single column (mobile web only).
Implementation, menu permissions and placeholder/403/404 pages: D-091 (`apps/office-app/src/features/shell`).

## Screens (MVP)
- **Auth**: login (EN|AR toggle), forgot/reset password, accept invite, verify email, signup → onboarding wizard. Session store,
  guards (`RequireAuth`, `GuestOnly`, `RequirePermission`), cross-tab sign-out and the idle timeout: D-090.
- **Onboarding** (8 steps, skippable, "Step n of 8"): account → office setup (jurisdiction default PALESTINE, language, currency) →
  invite team → welcome tour → first case → first hearing → first document → done checklist.
- **Dashboard** (role-aware): KPI cards — my open cases (Δ week), today's hearings, overdue tasks, unpaid invoices (sum, overdue),
  new documents, new clients; upcoming deadlines (7 days); recent activity; OM: team workload, revenue this month.
- **Cases list**: search, filters, chips [All][Mine][Litigation][Contracts][Archived][Urgent]; columns fileNumber, title, status,
  priority, type/subtype, client, next hearing, responsible, docs count; server pagination; saved view in URL.
- **Legal file page** (heart): header (back, `number • title`, status/priority tags, responsible, ⋮ reassign/change status/archive/delete)
  + tabs **Details, Sessions, Documents, Parties, Timeline, Tasks, Billing, AI, Notes, Audit**, tab in URL.
  Details: fields + client/court/judge/billing cards, next-hearing card with reminders, key counts.
  Documents: folder tree + list, upload dragger (multi), status/OCR chips, version history, share-with-client toggle, preview drawer (PDF/image).
  Parties: grouped by role, conflict warning banner. Timeline: grouped by month, icons per event type.
  Tasks: Kanban (TODO/IN_PROGRESS/BLOCKED/DONE, @dnd-kit) + list view. Billing: timer, time entries, invoices, retainer.
  AI: summaries per document/session with disclaimer, "generate", "create tasks from next steps".
- **Quick-create file modal**: title, client (search or inline create), type/subtype, priority, responsible lawyer, paralegal,
  billing method/rate, optional court/judge, description; "Create & open" / "Create".
- **Clients**: list + profile (Overview, Files, Documents, Invoices, Notes, Portal access).
- **Calendar**: month/week/agenda; hearings + task due dates; filter by lawyer; click → session drawer.
- **Tasks**: my tasks across files (list + Kanban), filters.
- **Team** (OM): members, invites, roles, deactivate w/ reassignment.
- **Settings** (OM): office profile, preferences (reminder days, billing defaults, file number format, enable AI/OCR), subscription
  & usage, security (idle timeout, audit retention), data export. **Profile**: name, phone, language, timezone, password, notification prefs.
- **Notifications** dropdown + page; actionable links.
- **Client portal**: login, my files (status, next hearing, public timeline), shared documents, upload requested docs, invoices.
- **Admin panel**: offices, subscriptions/plans, usage, platform audit, queue dashboard link.

## Keyboard shortcuts
Ctrl/Cmd+K search · Ctrl+Alt+N new file · Ctrl+Alt+C new client · Ctrl+Alt+T new task · Ctrl+Alt+U upload ·
Ctrl+Alt+H new hearing · Ctrl+/ help · Esc close. (Docs' Ctrl+N/Ctrl+Shift+N collide with browser shortcuts — use Alt variants.)
Shortcuts are listed in the help modal and localized.

## Accessibility
WCAG 2.1 AA: axe in component + E2E tests, keyboard reachability, focus rings, skip link, ARIA tabs, color is never the only
signal (status tags have text/icons), font scale 100/125/150%.

## Testing conventions
`data-testid` on interactive elements used by Cypress (`nav-cases`, `new-case-button`, `case-title-input`, `tab-documents`…).
Vitest + Testing Library for components/hooks; MSW for API mocks; Storybook stories for shared-ui in LTR and RTL.
