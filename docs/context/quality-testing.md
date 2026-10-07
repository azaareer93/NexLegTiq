# Engineering Standards, Quality Gates & Testing

> Source: "Complete Development Guidelines" (mandatory), "Complete Testing Strategy", Performance guide. Pragmatism: D-071, D-072.

## TypeScript
`strict` + `noUncheckedIndexedAccess`, `noImplicitReturns`, `noUnused*`, `exactOptionalPropertyTypes` (libs), target ES2022.
No `any` (use `unknown` + narrowing), no non-null `!` except tests, prefer type guards over `as`, `readonly` inputs,
discriminated unions for async/result states, branded IDs from `shared-types`. `import type` for types.

## Naming
files/folders kebab-case · classes/types/interfaces PascalCase (no `I`/`T` prefix) · enum values & constants UPPER_SNAKE ·
booleans `is/has/can/should` · REST paths plural kebab · DB tables/columns snake_case via `@@map`/`@map` ·
React components PascalCase in `components/<Name>/{Name.tsx, Name.test.tsx, index.ts}` · hooks `use-x.ts` exporting `useX`.

## Lint & format
ESLint (flat config in `packages/shared-config/eslint/base.mjs`, re-exported by the root `eslint.config.mjs`; D-094):
`@typescript-eslint/no-explicit-any`, `consistent-type-imports`, type-aware `no-floating-promises` and `no-unsafe-*` (the
latter off in tests), `import/order` (builtin · external · local, alphabetized), `max-lines` 300 (not tests), `complexity` 10,
`max-depth` 3, `no-console` (not `scripts/`), physical properties banned in inline `style`, `i18next/no-literal-string`
(apps and shared-ui), `@nx/enforce-module-boundaries`. Backend (`backend-rules.mjs`): no `$queryRawUnsafe`/`$executeRawUnsafe`,
no string cache keys outside `CacheKeys` (`nexlegtiq/no-raw-cache-key`), `// unscoped: <reason>`. All errors; `nx lint` runs
with `--max-warnings=0`. Fixtures proving the bans: `packages/shared-config/src/lint-rules.spec.ts`.
Prettier: singleQuote, trailingComma all, printWidth 100, semi, endOfLine lf (`pnpm format`, CI `pnpm format:check`; `*.md`
and `*.sql` are not formatted). Stylelint: logical properties (`pnpm lint:css`, CI).
Git hooks (installed by `pnpm install`, not husky — D-094): pre-commit `lint-staged`; commit-msg `commitlint` (conventional,
`Refs: MVP-n` required); pre-push `nx affected -t typecheck test` since the merge-base with `origin/develop`. Root scripts and
configs: `pnpm lint:root` (CI).

## Quality gates (CI blocks merge)
- lint 0 errors / 0 warnings, typecheck clean, build passes.
- Coverage ≥ 80% lines/branches for backend services, shared packages, security code; UI ≥ 70% (→ 80% before paid launch).
- `pnpm audit --prod` no high/critical; gitleaks clean; Prisma migration check (schema ↔ migrations in sync).
- PR title matches `^\[MVP-\d+\] (feat|fix|refactor|perf|test|docs|chore|build|ci)(\(.+\))?: .+`.
- Label `needs-human-review` required on PRs touching auth/, tenant/prisma extension, prisma/migrations, billing/, ai/pii (D-072).

## Testing pyramid
| Layer | Tool | What |
|---|---|---|
| Unit | Jest (backend, SWC) · Vitest (FE, packages) | services with mocked repos, pure utils, Zod contracts, hooks, components |
| Integration | Jest + Supertest against real Postgres 17 + Redis (Testcontainers or CI services), MinIO, Mailpit; MSW/nock for OpenAI/Gemini/Vision | every endpoint: happy path, validation (VAL-*), permission (AUTH-100), **cross-tenant (404)**, business rules (BIZ-*) |
| E2E | Cypress (both `ar` and `en`, 1440×900 + 390×844) | onboarding, create case, add party w/ conflict, schedule hearing + reminder, upload + OCR ready, AI summary (mocked provider), invoice, portal view |
| Perf | k6 | list cases p95 < 500 ms, search < 200 ms, upload ack < 2 s at 50 VUs |
| Security | gitleaks, pnpm audit/Snyk, Trivy (images), OWASP ZAP baseline on staging | weekly + before release |
| A11y | axe (jest-axe, cypress-axe) | WCAG 2.1 AA |
| AI evals | script over fixture set | before prompt/model changes |

Style: AAA, `describe(Service) › describe(method) › it('should … when …')`. Factories in `test/factories` (fishery), seeded
tenants A and B in every integration suite. No sleeping — await queues via test helpers (`drainQueue('ocr')`).
Test data seed `prisma/seed.ts` (reference data: PS/JO/EG courts, folders, task templates) + `seed-demo.ts` (demo office, users per role,
bilingual sample cases) — demo seed never runs in prod.

## Definition of Done (every ticket)
1. Acceptance criteria met and demonstrated (screenshot/gif for UI, curl/test for API).
2. Tests added at the right layers; coverage gate green; tenant-isolation test for new tenant endpoints.
3. i18n keys in **both** `ar` and `en`; RTL checked; no literal strings.
4. Swagger updated (from Zod); contracts in `shared-contracts`; error codes documented.
5. Audit logging for create/update/delete/download/share of case data.
6. Migrations reviewed (reversible or documented), seed updated if reference data changed.
7. `docs/context/*` or `decisions.md` updated if behavior/decision changed; Jira ticket commented with summary + PR link.
