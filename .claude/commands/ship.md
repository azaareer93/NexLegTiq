---
description: Open the PR for the current ticket branch (stacked on its parent when needed), update Jira, and record learnings.
argument-hint: "[--draft]"
---
Ship the current branch. Args: $ARGUMENTS

1. Derive the key from the branch (`MVP-<n>-…`); fetch the Jira issue title/AC. Base = `git config branch.<branch>.nlqParent`
   if set and that branch's PR is still open, else `develop`.
2. Gate: `pnpm nx affected -t lint typecheck build --base=origin/<base>` and `pnpm nx affected -t test --base=origin/<base>
   --coverage` pass locally (skip a run whose inputs did not change since it last passed in this session); working tree
   clean (untracked files that are not part of the ticket may stay); branch pushed (`git push -u origin HEAD`). If it fails,
   stop and report.
3. **Ticket keys**: `git log origin/<base>..HEAD --format=%B` and the PR title/body may contain no `MVP-<k>` other than this
   ticket's (merging auto-closes every key mentioned) — name other stories in words. Fix commit messages only if not pushed.
4. Determine `needs-human-review`: true if the diff touches `apps/backend-api/src/modules/auth/**`, `**/tenant*`, `**/prisma/**`,
   `**/billing/**`, `**/ai/**/pii*`, `packages/shared-types/src/permissions.ts`, `apps/backend-api/src/common/rbac/**`,
   `.github/**`, `.claude/hooks/**`, `.claude/commands/**` or `scripts/**`.
5. Create the PR to `<base>` with `gh pr create` (add `--draft` if asked):
   - Title: `[MVP-<n>] <type>(<scope>): <subject>` (conventional type from the main change).
   - Body from `.github/pull_request_template.md`: summary, Jira link `https://nexlegtiq.atlassian.net/browse/MVP-<n>`,
     AC checklist with evidence, test notes, screenshots (AR + EN) for UI, migrations, new decisions (`D-###`), risk/rollback.
     When stacked, start the body with `Stacked on #<parent PR> — merge that first.`
   - Labels: only labels that exist (`gh label list`); `enhancement`/`bug`/`documentation` + `needs-human-review` when applicable.
6. Jira: comment with a 3–5 line summary + PR link (`addCommentToJiraIssue`), transition to *In Review* (or the closest status the
   workflow offers; list transitions first). Don't move to Done — merge does that.
7. Memory: store durable, reusable learnings (patterns, gotchas) in Ruflo (`memory_store`, namespace `patterns` or `lessons`,
   key `MVP-<n>-<topic>`). If a new decision was made, ensure `decisions.md` has it.
8. Output the PR URL. Never merge it.
