# @nexlegtiq/shared-i18n

Translation resources (`ar`, `en`), glossary keys and `createI18n()`. May depend on `shared-types`. Decisions: D-087.

- Files: `src/locales/{ar,en}/<namespace>.json`; add every key to both locales (Arabic needs all six plural forms).
- Keys: `<namespace>.<key>` — `errors.AUTH-001`, `enums.role.LAWYER`, `legal.plaintiff`, `common.actions.save`.
- Types: `t()` keys are typed from the English files; an unknown key fails `typecheck`.
- `pnpm nx test shared-i18n` fails on a key missing in one locale, a missing plural form, or an untranslated error code,
  enum value, glossary term or contract validation key.

Source package (no build step): consumers import `src/index.ts` through the package `exports`.
Boundaries: `packages/shared-config/eslint/module-boundaries.mjs`.
