---
description: Open the PR for the current ticket branch, update Jira, and record learnings.
argument-hint: "[--draft]"
---
Ship the current branch. Args: $ARGUMENTS

1. Derive the key from the branch (`MVP-<n>-…`); fetch the Jira issue title/AC.
2. Gate: `pnpm nx affected -t lint typecheck test build` must pass locally; working tree clean; branch pushed
   (`git push -u origin HEAD`). If it fails, stop and report.
3. Determine `needs-human-review`: true if the diff touches `apps/backend-api/src/modules/auth/**`, `**/tenant*`, `**/prisma/**`,
   `**/billing/**`, `**/ai/**/pii*`, `packages/shared-types/src/permissions.ts`, `.github/**`, or `.claude/hooks/**`.
4. Create the PR to `develop` with `gh pr create` (add `--draft` if asked):
   - Title: `[MVP-<n>] <type>(<scope>): <subject>` (conventional type from the main change).
   - Body from `.github/pull_request_template.md`: summary, Jira link `https://nexlegtiq.atlassian.net/browse/MVP-<n>`,
     AC checklist with evidence, test notes, screenshots (AR + EN) for UI, migrations, new decisions (`D-###`), risk/rollback.
   - Labels: area labels + `needs-human-review` when applicable.
5. Jira: comment with a 3–5 line summary + PR link (`addCommentToJiraIssue`), transition to *In Review* (or the closest status the
   workflow offers; list transitions first). Don't move to Done — merge does that.
6. Memory: store durable, reusable learnings (patterns, gotchas) in Ruflo (`memory_store`, namespace `patterns` or `lessons`,
   key `MVP-<n>-<topic>`). If a new decision was made, ensure `decisions.md` has it and run `/sync-notion decisions` later.
7. Output the PR URL.
