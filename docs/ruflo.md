# Ruflo — memory & orchestration for NexLegTiq

[Ruflo](https://github.com/ruvnet/ruflo) adds persistent semantic memory (SQLite + HNSW vector search), learning hooks and
multi-agent swarms to Claude Code. In this repo it is the **long-term memory layer**; the repo itself stays the source of truth.

| Layer | Holds | Canonical? |
|---|---|---|
| Notion | product intent, business, design specs | intent |
| `docs/context/*.md` + `decisions.md` | engineering digest + resolved conflicts | **yes (engineering)** |
| `CLAUDE.md`, `.claude/rules`, skills | how Claude must work here | yes |
| Ruflo memory | searchable copy of the digest + accumulated patterns/lessons | derived + learned |
| Jira MVP | what to build next, status | yes (work) |

## One-time setup (on your machine, repo root)
Requires Node 20+ (repo uses 22), git, Claude Code.
```bash
# 1) Install/initialise Ruflo without clobbering our CLAUDE.md/.claude config
npx ruflo@latest init upgrade --add-missing     # adds Ruflo helpers/skills/agents only where missing
#    (if it's your first time and init refuses, run `npx ruflo@latest init wizard`, choose NOT to overwrite
#     CLAUDE.md and .claude/settings.json, then `git diff` and keep our versions of those two files)
npx ruflo@latest doctor --fix

# 2) MCP server is already declared in .mcp.json as "claude-flow" — approve it when Claude Code asks,
#    or register globally: claude mcp add claude-flow -- npx -y ruflo@latest mcp start

# 3) Seed memory from the knowledge base (idempotent; re-run after docs change)
npx ruflo@latest memory init
node scripts/ruflo-seed.mjs
npx ruflo@latest memory search -q "tenant isolation" --build-hnsw

# 4) Optional: let Ruflo learn codebase patterns once code exists
npx ruflo@latest hooks pretrain --depth deep
```
### Windows notes
- Run the seed script with **Claude Code closed**. On Windows Ruflo writes via sql.js (its native SQLite bridge is disabled
  upstream, ruflo #3024) and refuses to write while another process — usually Claude Code's `claude-flow` MCP server —
  holds `.swarm/memory.db` open. The script detects this (`memory.db-wal` / `memory.db-shm` present, or a running
  `ruflo mcp start` process) and exits with code 2. Writing underneath the MCP server leaves its in-memory copy stale and makes
  it refuse later writes until Claude Code restarts. **Inside a session** use `--export=<file> [--changed-since=<commit>]` and
  store the entries with the MCP tool `memory_store` (what `/ticket` step 0 does, docs/tooling.md#7).
- Spec keys are `<file>/<section-slug>` (the MCP tools reject `#`). Entries seeded before 2026-09-30 used `#`; one full
  re-seed with Claude Code closed adds the `/` keys, and the old `#` entries are harmless duplicates.
- If those two files remain with nothing running, they are stale: move them aside (`Move-Item .swarm\memory.db-wal .swarm\memory.db-wal.bak`,
  same for `-shm`) and re-run.
- Don't set `CLAUDE_FLOW_ENABLE_NATIVE_BRIDGE_ON_WINDOWS=1`; upstream disabled it because it can crash Node.
- With `npm i -g ruflo` you can call it as `ruflo …`; the seed script finds the global install automatically.

Ruflo writes local state under `.claude-flow/` and `.swarm/` (git-ignored) — memory is per machine. Commit knowledge to
`docs/context/` and re-seed; don't rely on Ruflo as the only copy of anything important.

## Namespaces
| Namespace | Written by | Content |
|---|---|---|
| `nexlegtiq-spec` | `scripts/ruflo-seed.mjs` | sections of `docs/context/*.md` |
| `decisions` | seed script + `/adr` | one entry per `D-###` |
| `patterns` | `/ship`, `/remember` | "how we do X here" with file paths (e.g. `pattern-tenant-worker`) |
| `lessons` | `/ship`, `/remember` | gotchas, incident learnings, failed approaches and why |
| `collaboration` | swarm runs | scratch shared state for multi-agent tasks (ephemeral) |

## Using it from Claude Code
- Before designing: `memory_search` ("how do we paginate lists", "reminder rescheduling") across `patterns`, `lessons`, `decisions`.
- After shipping: store reusable learnings (the `/ship` command does this).
- Big parallel work (e.g. a whole epic's CRUD scaffolding): Ruflo swarms are available (`swarm init --topology hierarchical`),
  but prefer Claude Code subagents from `.claude/agents/` for normal tickets — fewer moving parts.

## Hooks coexistence
`ruflo init` may add its own hooks (pre/post edit learning, statusline, context persistence) to `.claude/settings.json`.
Keep ours (session-start, guard-bash, guard-files, format-file) — merge the arrays rather than replacing them, and keep
`guard-*` hooks first in the `PreToolUse` lists.
