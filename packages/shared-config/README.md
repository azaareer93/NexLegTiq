# @nexlegtiq/shared-config

Workspace tooling presets. `eslint/module-boundaries.mjs` is the single source of Nx boundary constraints.

Source package (no build step): consumers import `src/index.ts` through the package `exports`.
Boundaries: `packages/shared-config/eslint/module-boundaries.mjs`. Test: `pnpm nx test shared-config`.
