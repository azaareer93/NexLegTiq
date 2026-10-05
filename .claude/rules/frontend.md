---
paths:
  - "apps/office-app/**"
  - "apps/client-portal/**"
  - "apps/admin-panel/**"
  - "packages/shared-ui/**"
  - "packages/shared-i18n/**"
---
# Frontend rules (React 19 + AntD 6)

- Feature folders: `src/features/<feature>/{api,components,hooks,pages,routes.tsx,index.ts}`; pages lazy-loaded per route.
- Server state only via TanStack Query hooks built on `@nexlegtiq/shared-api-client` (query keys from a `keys.ts` factory per feature).
  Zustand only for client state (auth session, UI prefs). Never store the access token in localStorage/sessionStorage.
- Forms: AntD `Form` + Zod schema from `shared-contracts` (via a `zodRule` adapter) — same validation as the backend.
- Map API `error.code` → `t('errors.<CODE>')`; show field errors from `error.details`. Every failure is an `ApiError` (D-089);
  restore the session with `authApi.refresh()` at app start; `onAuthFailure` clears stores + `queryClient.clear()` and goes to sign-in.
- **No literal user-facing strings**: `t('feature.key')`; add keys to both `ar` and `en`; use `docs/context/glossary.md` terms.
- **RTL**: CSS logical properties only; icons that imply direction flip in RTL; wrap numbers/emails/file numbers in `<bdi>`/`dir="ltr"`.
- Every app root is `<NexProvider>` (shared-ui). Theme tokens only (AntD tokens from `nexTheme`, D-088), no hard-coded colors/spacing.
  Use the shared components: `PageHeader`, `StatusTag`/`PriorityTag`, `EmptyState`/`ErrorState`/`LoadingSkeleton`, `ConfirmModal`,
  `Ltr`/`Bdi`, `DirectionalIcon`, `AiDisclaimer`.
- Permissions: gate UI with `useCan('create:case')` from shared permissions; the server remains the authority.
- Accessibility: labelled inputs, keyboard-reachable actions, `data-testid` on interactive elements used by E2E.
- AI output always rendered with `<AiDisclaimer />`.
- Tests: Vitest + Testing Library + MSW; render in both `ar` (RTL) and `en`; jest-axe on pages.
- Skill to use: `react-feature`, and `rtl-i18n` for any UI text/layout change.
