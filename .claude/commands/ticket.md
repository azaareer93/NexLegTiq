---
description: Deliver a Jira ticket end to end — load, plan, branch (stacked if needed), implement, verify, review, ship, sync Notion.
argument-hint: MVP-123 [--auto] [--no-ship] [--decisions-from D-###]
---
Deliver Jira issue **$ARGUMENTS** (project MVP, site nexlegtiq.atlassian.net, cloudId `9cb815a7-782c-46e9-a4ca-74b3977b88f4`)
from plan to open PR. Follow the `jira-workflow` skill. `--auto` = run unattended (called by `/autopilot`): never ask me,
follow the **Skip rule** instead. `--no-ship` = stop after step 9 (review fixes committed, nothing pushed). `--decisions-from D-###` = number new
decisions from there (set by `/autopilot` when two tickets run in parallel), else the next free number.

**Never:** merge a PR, force-push, rewrite pushed history, run `prisma migrate reset`, read `.env`, change permissions or
settings, or name another `MVP-<n>` key in a commit, PR title or PR body (merging auto-closes every key mentioned).

0. **Sync local knowledge** (docs/tooling.md#7). Skip any part whose tool is unavailable and say so in one line.
   - `git fetch && git switch develop && git pull --ff-only` (the post-merge hook refreshes Graphify; if
     `.git/hooks/post-merge` lacks the `nexlegtiq-post-merge` block, run `pnpm hooks:install` first and say so).
   - **Ruflo**: if `.git/nexlegtiq/ruflo-pending` exists, run
     `node scripts/ruflo-seed.mjs --export=<scratchpad>/ruflo-changed.json --changed-since=$(cat .git/nexlegtiq/ruflo-pending)`,
     store every exported entry with the claude-flow MCP tool `memory_store` (its namespace, key, value; tags `nexlegtiq`,
     `seed`), then delete the pending file. Never run the seed script without `--export` in a session: the MCP server owns
     `.swarm/memory.db`. If `memory_store` refuses (WAL sidecar files), skip the Ruflo part, keep the pending file and say so.
   - **Notion**: if `git rev-parse HEAD:docs/context/decisions.md` differs from `.git/nexlegtiq/notion-decisions`
     (or that file is missing), run `/sync-notion decisions`.
   - Make sure the dev stack is up for integration tests: `docker compose -f docker/compose.dev.yml up -d`.
1. **Load**: fetch the issue (`getJiraIssue`, fields incl. description, issuelinks, parent, labels, comment). If it's an
   Epic, pick its first eligible child (`--auto`) or list the children and ask.
2. **Context**: read `docs/context/00-index.md`, the topic files for the ticket's labels/epic, and `decisions.md`.
   `memory_search` (namespaces `patterns`, `lessons`, `decisions`) for prior work. Notion only if the digest lacks detail.
3. **Blockers → base branch**: for every "is blocked by" link:
   - Done → nothing to do.
   - In Review with an open PR (`gh pr list --search "MVP-<k>" --state open`) → **stack**: the base is that PR's branch.
     With several such parents, stack on the newest and merge the others into the new branch (`git merge --no-edit`).
     Refuse stacks deeper than 3 (treat as not eligible).
   - Anything else → not eligible: `--auto` → return `SKIPPED: blocked by <keys>`; interactive → say so and stop unless I confirm.
4. **Plan** (short): approach, files, contracts/migrations, test plan per layer, risks, spec conflicts + proposed `D-###`.
   Proceed without waiting unless the plan hits an expensive-to-reverse decision (CLAUDE.md: core entity schema shape,
   auth/security model, pricing/legal promises, infra spend):
   - interactive → ask me (AskUserQuestion, recommended option first);
   - **Skip rule** (`--auto`) → post the questions as one Jira comment (each with options and your recommendation), add the
     label `needs-decision`, move the issue back to *To Do*, delete the local branch if it has no commits, and return
     `SKIPPED: needs decision`. Everything with a sensible default is decided by you and recorded as `D-###` — not a question.
5. **Branch**: if a branch `MVP-<n>-*` already exists (local or `origin`), switch to it and resume from what its commits
   and the Jira comments show is done. Otherwise `git switch -c MVP-<n>-<kebab-summary> <base>` (`origin/develop`, or the stack parent from step 3). When
   stacked, record it: `git config branch.MVP-<n>-<slug>.nlqParent <parent-branch>`.
6. **Transition** to *In Progress* (`getTransitionsForJiraIssue` → `transitionJiraIssue`); assign to me if unassigned.
7. **Implement** in small conventional commits (`type(scope): subject` + `Refs: MVP-<n>`), tests alongside code, following
   `.claude/rules/*` and the relevant skills (`nest-module`, `react-feature`, `prisma-change`, `ai-feature`, `rtl-i18n`,
   `tenant-isolation`). Use subagents for parallelizable parts when it clearly saves time.
8. **Verify**: `pnpm nx affected -t lint typecheck build --base=<base>`, then `pnpm nx affected -t test --base=<base>
   --coverage` (coverage is a separate run: `--coverage` breaks typecheck), the backend `integration` target when backend
   code changed, and `pnpm format:check`. Fix until green.
9. **Review**: run `/review`. Verify every finding against the code, drop false positives, apply Blockers and Should-fix.
   Findings that need my decision: interactive → ask; `--auto` → apply the recommended option if it is cheap to reverse and
   record it in the ticket's `D-###`; otherwise follow the Skip rule but **keep the branch and push it** (no PR), so the work
   is not lost. Re-run step 8 after fixes and commit them (`fix(<scope>): review fixes …`).
10. **Ship**: run `/ship` (it opens the PR against the stack parent when `nlqParent` is set).
11. **Notion**: if `decisions.md` changed on this branch, run `/sync-notion decisions`.
12. **Report** in ≤ 8 lines: PR URL, base (develop or parent), decisions made, deviations, anything left for me.
    `--auto` → end with the line `DONE: MVP-<n> <PR URL>`.
