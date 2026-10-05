# @nexlegtiq/shared-ui

The NexLegTiq theme, app root and base components for the three apps. May depend on `shared-types`, `shared-utils` and
`shared-i18n`. Decisions: D-087 (language), D-088 (theme, fonts, components).

- `NexProvider`: wrap each app once. Language and direction, the AntD theme (`nexTheme`), self-hosted fonts, AntD `App`.
- Components: `PageHeader`, `StatusTag`/`PriorityTag`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `Ltr`/`Bdi`,
  `DirectionalIcon`, `ConfirmModal`, `AiDisclaimer`, `Can`.
- Storybook: `pnpm nx storybook shared-ui` (Language toolbar: Arabic RTL / English LTR; a11y panel).
- Tests: `pnpm nx test shared-ui` — every story is rendered in both languages and checked with axe.

Source package (no build step): consumers import `src/index.ts` through the package `exports`.
Boundaries: `packages/shared-config/eslint/module-boundaries.mjs`.
