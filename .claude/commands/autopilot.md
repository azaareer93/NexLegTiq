---
description: Unattended delivery loop — fix own PRs, pick the most-blocking highest-priority ticket, deliver it with /ticket --auto, repeat.
argument-hint: "[--once] [--max-open-prs N] [--parallel 1|2] (default 1)"
---
Run the delivery loop for project MVP (cloudId `9cb815a7-782c-46e9-a4ca-74b3977b88f4`). Args: $ARGUMENTS
`--once` = one iteration, then print exactly one of `DONE: …`, `SKIPPED: …`, `FIXED: …` or `IDLE` as the last line
(used by `scripts/autopilot.sh`, which relaunches a fresh session per iteration). Without it, keep iterating in this session.

**Guardrails (all of /ticket's "Never" list, plus):** I merge — you never do (`gh pr merge` is off limits here). Never close,
delete or re-prioritise Jira issues, never edit another person's comments, never touch a branch that has no `MVP-<n>` prefix.
Stop at once when `.git/nexlegtiq/autopilot-stop` exists. Each iteration appends one line to `.git/nexlegtiq/autopilot.log`:
`<ISO time> <outcome> <key> <PR URL or reason>`.

## One iteration
1. **Own PRs first** (`gh pr list --author @me --state open --json number,title,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup`).
   Handle the first that needs it, then end the iteration with `FIXED: #<n> <what>`:
   - **Parent merged** (base is not `develop` and the base branch's PR is merged): `gh pr edit <n> --base develop`,
     `git switch <branch> && git merge --no-edit origin/develop` (squash merges leave the parent's original commits on the
     branch — merging develop resolves them; never rebase or force-push), re-verify, push, `git config --unset branch.<branch>.nlqParent`.
   - **After every merge of `develop` (or a parent) into a branch**: `pnpm nx run backend-api:prisma-generate` before
     committing — the commit hook lints with the generated client, and a stale one fails on new models. Push branches
     **one at a time** in the foreground: each push runs the pre-push typecheck + tests, and two at once exhaust memory.
   - **Failing checks**: read the failed job (`gh run view --log-failed`), fix on the branch, verify, push.
   - **Conflicts with its base**: merge the base in, resolve, verify, push.
   - **Changes requested / new review comments from the owner**: address each (`gh pr view <n> --comments`), reply on the
     PR with what changed, push. A comment asking a question you cannot answer → reply and leave it.
2. **Capacity**: if I have `--max-open-prs` (default 6) or more open PRs, do not start a ticket — print `IDLE` (waiting
   for reviews) and end the iteration.
3. **Pick the ticket** — resume before starting:
   - An MVP issue *In Progress* assigned to me whose local or remote branch exists → resume it with `/ticket <key> --auto`
     (it continues on the existing branch instead of creating one).
   - Otherwise search `project = MVP AND statusCategory = "To Do" AND issuetype in (Story, Task, Bug) AND (labels is EMPTY
     OR labels not in (needs-decision, autopilot-skip)) ORDER BY priority DESC, rank ASC` (fields `priority`, `labels`,
     `issuelinks`, `parent`, `status`; up to 50). Keep issues that are **eligible**: every "is blocked by" link is Done, or
     In Review with an open PR (stack depth ≤ 3). Order by: priority (highest first) → number of not-Done issues it
     **blocks** (most first) → lowest `slice-<n>` label → rank. Take the first.
   - Nothing eligible → print `IDLE` and end the iteration.
4. **Deliver**: `/ticket <key> --auto`. It returns `DONE: …` or `SKIPPED: …` — log it and end the iteration.
   If it fails unexpectedly (tool outage, a check you cannot fix within the ticket), push what is committed, comment the
   state on the Jira issue, add the label `autopilot-skip`, log `SKIPPED: <key> <reason>` and continue.
5. **Two at once** (only with `--parallel 2`; the default is 1 — two worktrees running full tests ran the machine out of memory): when the pick list holds a second eligible
   ticket that does not collide with the first, deliver both at the same time — each in its own subagent with
   `isolation: "worktree"`, told to run `/ticket <key> --auto` and return its last line. Collision-free means: different
   areas (one `backend` + one `frontend`/`portal`/`admin`, or `docs`/`infra` with anything), at most one of them touches
   `prisma/` (migrations share the dev database), neither is the other's blocker. Give each its first decision number
   (the first ticket the next free `D-###`, the second that number + 5; gaps are fine — numbers are ids). The coordinator
   (you) logs both results and runs the Notion sync once afterwards. The capacity check counts both PRs.
6. **Notify me**: after a `DONE` or a `SKIPPED: needs decision`, send a push notification (`PushNotification`, load it
   with ToolSearch) with the key, the outcome and the PR or Jira link. Nothing for `FIXED`/`IDLE`.
7. **Groom when idle**: on the first `IDLE` of a day, run one grooming pass before waiting — `/backlog` restricted to
   adding missing "Blocks" links and splitting stories over ~3 days among `statusCategory = "To Do" AND labels = phase-1`
   (never change priorities, ranks, statuses or slices). Record the date in `.git/nexlegtiq/autopilot-groomed`.

## Looping
- With `--once`: end after one iteration.
- Inside `/loop` (dynamic): end the iteration and schedule the next with `ScheduleWakeup` — 60 s after `DONE`/`SKIPPED`/`FIXED`,
  1800 s after `IDLE`.
- Otherwise: run the next iteration right away; after two `IDLE`s in a row, stop and report.
- After each `DONE`, if `decisions.md` changed since `.git/nexlegtiq/notion-decisions`, `/sync-notion decisions` (already
  done by /ticket step 11 unless it failed).

## Report (when stopping)
≤ 10 lines: PRs opened (stack order), tickets skipped with the reason, decisions waiting for me (`labels = needs-decision`).
