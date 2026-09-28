# NexLegTiq

The intelligent, bilingual (Arabic/English) workspace for modern law offices in MENA — cases, hearings & reminders,
documents with OCR, tasks, billing, AI summaries and a client portal. Launch market: Palestine.

> Status: pre-code. The repository currently contains the engineering knowledge base and the Claude Code delivery setup.
> The application is scaffolded by **MVP-28** (see `docs/jira/backlog.md`).

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
