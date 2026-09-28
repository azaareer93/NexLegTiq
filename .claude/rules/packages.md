---
paths:
  - "packages/**"
---
# Shared packages rules

- Respect Nx boundaries: `shared-types` (no deps) ← `shared-utils` ← `shared-contracts` ← `shared-api-client`;
  `shared-ui` may use types/utils/i18n; nothing imports apps.
- Public API only through each package's `src/index.ts`; no deep imports across packages.
- `shared-contracts`: one file per resource `<resource>.contract.ts` exporting `CreateXSchema`, `UpdateXSchema`, `XQuerySchema`,
  `XResponseSchema`, and `type X = z.infer<…>`; enums imported from `shared-types`. Error messages are i18n keys, not prose.
- `shared-types/src/permissions.ts` is the single RBAC matrix — change it only with the matching `auth-rbac.md` update.
- Pure, deterministic, 100% unit-tested utils (dates with explicit timezone, money via decimal.js, Arabic normalization).
- Breaking changes to contracts require updating backend + all apps in the same PR.
