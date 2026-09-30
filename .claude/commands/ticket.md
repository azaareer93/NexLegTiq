---
description: Start work on a Jira ticket — load it, plan against the specs, branch, implement with tests.
argument-hint: MVP-123
---
Start work on Jira issue **$ARGUMENTS** (project MVP, site nexlegtiq.atlassian.net, cloudId `9cb815a7-782c-46e9-a4ca-74b3977b88f4`).
Follow the `jira-workflow` skill.

0. **Sync local knowledge** (docs/tooling.md#7). Skip any part whose tool is unavailable and say so in one line.
   - `git fetch && git switch develop && git pull --ff-only` (the post-merge hook refreshes Graphify; if
     `.git/hooks/post-merge` lacks the `nexlegtiq-post-merge` block, run `pnpm hooks:install` first and say so).
   - **Ruflo**: if `.git/nexlegtiq/ruflo-pending` exists, run
     `node scripts/ruflo-seed.mjs --export=<scratchpad>/ruflo-changed.json --changed-since=$(cat .git/nexlegtiq/ruflo-pending)`,
     store every exported entry with the claude-flow MCP tool `memory_store` (its namespace, key, value; tags `nexlegtiq`,
     `seed`), then delete the pending file. Never run the seed script without `--export` in a session: the MCP server owns
     `.swarm/memory.db`. If `memory_store` refuses (WAL sidecar files), stop the Ruflo part and tell me to restart Claude
     Code with the fix from docs/ruflo.md; keep the pending file.
   - **Notion**: if `git rev-parse HEAD:docs/context/decisions.md` differs from `.git/nexlegtiq/notion-decisions`
     (or that file is missing), run `/sync-notion decisions`.
   - task-observer: its session-start protocol already offers an overdue review; nothing extra here.
1. **Load**: fetch the issue with the Atlassian MCP (`getJiraIssue`) including description, acceptance criteria, parent epic, links,
   comments, labels. If it's an Epic, list its children instead and ask which to start.
2. **Context**: read `docs/context/00-index.md`, then the topic files relevant to the ticket's labels/epic and `decisions.md`.
   Search Ruflo memory (`memory_search`, namespaces `patterns`, `lessons`, `decisions`) for prior work on this area.
   Open the linked Notion page only if the digest lacks needed detail.
3. **Check blockers**: if "is blocked by" links are not Done, say so and stop unless I confirm.
4. **Plan** (short): approach, files to touch, contracts/migrations, test plan per layer, risks, any spec conflict + proposed
   `D-###` resolution. Proceed without waiting unless the plan hits an expensive-to-reverse decision (see CLAUDE.md).
5. **Branch**: `git fetch && git switch -c MVP-<n>-<kebab-summary> origin/develop` (or current `develop`).
6. **Transition** the issue to *In Progress* (`getTransitionsForJiraIssue` → `transitionJiraIssue`) and assign it to me if unassigned.
7. **Implement** in small, conventional commits (`type(scope): subject` + `Refs: MVP-<n>`), tests alongside code, following the
   `.claude/rules/*` for the paths touched and the relevant skills (`nest-module`, `react-feature`, `prisma-change`, `ai-feature`,
   `rtl-i18n`, `tenant-isolation`). Use subagents for parallelizable parts when it clearly saves time.
8. **Verify**: run `pnpm nx affected -t lint typecheck test` (and e2e for API changes). Fix until green.
9. Summarize what changed and suggest running `/review` then `/ship`.
