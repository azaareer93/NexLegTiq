# NexLegTiq

The intelligent, bilingual (Arabic/English) workspace for modern law offices in MENA — cases, hearings & reminders,
documents with OCR, tasks, billing, AI summaries and a client portal. Launch market: Palestine.

> Status: workspace scaffolded (MVP-28). Feature work follows the slices in `docs/jira/backlog.md`.

## Getting started
Prerequisites: **Node 22** (`.nvmrc`) and **pnpm 10** (`corepack enable` picks the version pinned in `package.json`).

```bash
pnpm install
pnpm nx serve backend-api        # http://localhost:3000/api/v1 · Swagger /api/docs · /health · metrics :9464/metrics
pnpm nx serve office-app         # http://localhost:4200
pnpm nx serve admin-panel        # http://localhost:4201
pnpm nx serve client-portal      # http://localhost:4202
pnpm nx serve-worker backend-api # BullMQ worker process (no HTTP)
pnpm nx run-many -t lint typecheck test build   # everything CI checks
pnpm nx e2e backend-api-e2e      # boots the API and runs the Jest/Supertest suite
pnpm nx graph                    # project graph and module boundaries
```

| Project | Stack | Tags |
|---|---|---|
| `apps/backend-api` | NestJS 11, webpack + SWC; entrypoints `main` (HTTP) and `worker` (BullMQ) | `type:app`, `scope:backend` |
| `apps/{office-app,admin-panel,client-portal}` | React 19, Vite 8, React Router 8, Vitest | `type:app`, `scope:frontend` |
| `packages/shared-*` | TS source packages (`@nexlegtiq/*`), consumed without a build step | `type:lib`, `scope:shared`, `layer:*` |

Module boundaries are defined once in `packages/shared-config/eslint/module-boundaries.mjs` and enforced by
`@nx/enforce-module-boundaries`. Docker dev stack: MVP-30. Full lint/format tooling: MVP-29.

## Where things are
| Path | What |
|---|---|
| `CLAUDE.md` | How Claude Code works in this repo (read first) |
| `docs/context/` | Engineering digest of the Notion specs + **decision log** (`decisions.md`) |
| `docs/jira/backlog.md` | Epic/story map and delivery slices for Jira project MVP |
| `docs/ruflo.md` | Ruflo memory setup and namespaces |
| `.claude/` | Subagents, skills, slash commands, path-scoped rules, hooks, settings |
| `.mcp.json` | MCP servers: Atlassian (Jira), Notion, Ruflo (`claude-flow`) |
| `.github/` | CI, PR conventions, PR template |
| `scripts/` | `ruflo-seed.mjs` (load knowledge into Ruflo), `test-hooks.mjs` |

## Working loop (Claude Code)
```
/standup                 # what's next
/ticket MVP-28           # load ticket → plan → branch → implement → test
/review                  # parallel review by specialist subagents
/ship                    # PR + Jira transition + learnings to Ruflo
/adr "title — decision"  # record a new engineering decision
/sync-notion decisions   # mirror decision log to Notion
```

## One-time setup on your machine
1. Clone, open in Claude Code, approve the project MCP servers (Atlassian, Notion, claude-flow) and sign in to Atlassian/Notion when prompted.
2. Ruflo: follow `docs/ruflo.md` (`npx ruflo@latest init upgrade --add-missing`, then `node scripts/ruflo-seed.mjs`).
3. GitHub: install the **GitHub for Jira** app on this repo (links branches/PRs to MVP tickets) and protect `main`/`develop`
   (required checks: CI, PR conventions; squash merge only).
4. Create `develop` from `main` (the setup commit lands on `main`).

Tech stack, conventions and decisions: `docs/context/00-index.md`.
