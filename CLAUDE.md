# NexLegTiq — Claude Code project memory

NexLegTiq is a multi-tenant, bilingual (Arabic/English, RTL/LTR), AI-assisted workspace for law offices in MENA.
Launch market: Palestine. Solo-founder project: prefer simple, low-ops, well-tested solutions.

## How to work here
- **Specs are intent, not scripture.** Notion → digested in `docs/context/` → conflicts resolved in `docs/context/decisions.md`
  (imported below). If code, ticket and docs disagree, `decisions.md` wins; if it's silent, make the senior-engineer call,
  record a new `D-###` entry, and mention it in the PR + Jira comment. Only stop and ask on decisions that are expensive to reverse
  (schema shape of core entities, auth/security model, pricing/legal promises, infra spend).
- Start every task from a Jira key (`MVP-123`). Use `/ticket MVP-123` to load it, plan, branch, and implement.
- Before non-trivial work read `docs/context/00-index.md` and the topic file it points to. Use Ruflo memory search
  (`memory_search` / `npx ruflo@latest memory search -q "..."`) for prior patterns and lessons when available.
- Finish with `/review` then `/ship` (PR + Jira transition + comment). Record durable learnings with `/remember`.

## Repo map (target — scaffolded by the Foundation epic)
- `apps/office-app` (React 19 + Vite + AntD 5, :4200) · `apps/client-portal` (:4202) · `apps/admin-panel` (:4201)
- `apps/backend-api` (NestJS 11 + Prisma 7 + PG17/pgvector + Redis/BullMQ, :3000, `/api/v1`, Swagger `/api/docs`; worker entry `src/worker.ts`)
- `packages/shared-{types,utils,contracts,api-client,ui,i18n,config}` — scope `@nexlegtiq/*`, Nx module boundaries enforced.
- `docs/context/` knowledge base · `docs/runbooks/` · `.claude/` agents, skills, commands, hooks.

## Commands (once the workspace exists)
```bash
pnpm install
docker compose -f docker/compose.dev.yml up -d      # postgres(pgvector) redis minio mailpit clamav
pnpm nx run backend-api:prisma-migrate               # prisma migrate dev
pnpm nx run backend-api:seed                         # reference + demo data (never prod)
pnpm nx serve backend-api | office-app | client-portal | admin-panel
pnpm nx affected -t lint typecheck test build         # what CI runs
pnpm nx run backend-api-e2e:e2e                       # integration (real PG/Redis)
pnpm nx run e2e:e2e                                   # Cypress
```

## Non-negotiables (details in docs/context)
1. **Tenant isolation**: every tenant table has `officeId`; all access goes through the Prisma tenant extension + CLS
   context; cross-tenant ⇒ 404; cache keys `o:{officeId}:…`; storage keys `{officeId}/…`. New tenant endpoint ⇒ tenant-isolation test.
2. **RBAC** from the single matrix in `packages/shared-types/src/permissions.ts` (`auth-rbac.md`). `@RequirePermissions` = ALL,
   `@RequireAnyPermission` = ANY.
3. **Contracts first**: Zod schemas in `shared-contracts` drive validation, types, Swagger and the FE client.
4. **API envelope + error codes** from `api-conventions.md`; never invent ad-hoc response shapes or codes without adding them there.
5. **i18n/RTL**: no literal UI strings; add keys to both `ar` and `en`; CSS logical properties only; use `glossary.md` terms; verify RTL.
6. **Enums UPPER_SNAKE**, IDs UUIDv7, money `Decimal` + currency (never JS floats), timestamps `timestamptz` UTC.
7. **Async heavy work** (OCR, AI, email, reminders, PDFs) goes through BullMQ; HTTP returns 202 + job id.
8. **AI**: PII redaction before provider calls, Zod-validated JSON output, quota + cost tracking, disclaimer in UI, human confirms
   any AI-suggested change.
9. **Security**: no secrets in code/logs; Zod at boundaries; no `$queryRawUnsafe`; uploads scanned; downloads via presigned URLs + audit.
10. Changes to auth, tenant extension, migrations, billing, AI PII handling ⇒ PR label `needs-human-review` (the owner reviews).

## Conventions
- TS strict, no `any`, branded ids, kebab-case files, PascalCase types, conventional commits.
- Branch `MVP-<n>-<slug>` from `develop`; PR title `[MVP-<n>] type(scope): subject`; squash merge; `Refs: MVP-<n>` footer.
- Definition of Done: `docs/context/quality-testing.md#definition-of-done`.
- Tests: Jest/Vitest unit, Supertest integration on real PG/Redis, Cypress journeys in both languages.

## Tooling available to Claude
- MCP: Atlassian (Jira `MVP`, cloud `nexlegtiq.atlassian.net`), Notion (spec source), Ruflo `claude-flow` (memory/swarm) — `.mcp.json`.
- Subagents in `.claude/agents/`: `architect`, `backend-engineer`, `frontend-engineer`, `code-reviewer`, `security-auditor`,
  `qa-engineer`, `rtl-i18n-reviewer`, `spec-guardian`.
- Skills in `.claude/skills/`: `nest-module`, `react-feature`, `prisma-change`, `jira-workflow`, `rtl-i18n`, `ai-feature`, `tenant-isolation`.
- Commands: `/ticket`, `/spec-check`, `/review`, `/ship`, `/adr`, `/remember`, `/sync-notion`, `/standup`, `/backlog`.

## Decisions (canonical — keep in context)
@docs/context/decisions.md
