---
description: Start work on a Jira ticket — load it, plan against the specs, branch, implement with tests.
argument-hint: MVP-123
---
Start work on Jira issue **$ARGUMENTS** (project MVP, site nexlegtiq.atlassian.net, cloudId `9cb815a7-782c-46e9-a4ca-74b3977b88f4`).
Follow the `jira-workflow` skill.

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
