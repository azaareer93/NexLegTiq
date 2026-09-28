---
paths:
  - "apps/office-app/**"
  - "apps/client-portal/**"
  - "apps/admin-panel/**"
  - "packages/shared-ui/**"
  - "packages/shared-i18n/**"
---
# Frontend rules (React 19 + AntD 5)

- Feature folders: `src/features/<feature>/{api,components,hooks,pages,routes.tsx,index.ts}`; pages lazy-loaded per route.
- Server state only via TanStack Query hooks built on `@nexlegtiq/shared-api-client` (query keys from a `keys.ts` factory per feature).
  Zustand only for client state (auth session, UI prefs). Never store the access token in localStorage/sessionStorage.
- Forms: AntD `Form` + Zod schema from `shared-contracts` (via a `zodRule` adapter) — same validation as the backend.
- Map API `error.code` → `t('errors.<CODE>')`; show field errors from `error.details`.
- **No literal user-facing strings**: `t('feature.key')`; add keys to both `ar` and `en`; use `docs/context/glossary.md` terms.
- **RTL**: CSS logical properties only; icons that imply direction flip in RTL; wrap numbers/emails/file numbers in `<bdi>`/`dir="ltr"`.
- Theme tokens only (from `shared-ui/theme`), no hard-coded colors/spacing. Status/priority tags use shared components.
- Permissions: gate UI with `useCan('create:case')` from shared permissions; the server remains the authority.
- Accessibility: labelled inputs, keyboard-reachable actions, `data-testid` on interactive elements used by E2E.
- AI output always rendered with `<AiDisclaimer />`.
- Tests: Vitest + Testing Library + MSW; render in both `ar` (RTL) and `en`; jest-axe on pages.
- Skill to use: `react-feature`, and `rtl-i18n` for any UI text/layout change.
