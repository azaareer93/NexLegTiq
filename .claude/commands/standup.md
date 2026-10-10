---
description: Daily status from Jira + git — what moved, what's in progress, what waits for the owner, what's next.
---
Build a short standup for project MVP:
1. JQL via Atlassian MCP: `project = MVP AND updated >= -1d ORDER BY updated DESC`, plus `status = "In Progress"` and
   the top 5 of `status = "To Do" AND labels = slice-1 ORDER BY rank` (fall back to priority if no rank).
2. **Waiting for you**: `project = MVP AND labels = needs-decision AND statusCategory != Done` (with the question comment's
   one-line summary each), and open PRs awaiting review (`gh pr list --state open --json number,title,baseRefName,
   statusCheckRollup,reviewDecision`) in stack order — a stacked PR shows "after #<parent>", so the merge order is clear.
3. `git log --since=yesterday --oneline --all`, and the autopilot log (`.git/nexlegtiq/autopilot.log`, last 24 h) if present.
4. Output, under 20 lines:
   - **Waiting for you** first: questions to answer (key — question — my recommendation), PRs to review/merge in order
     (number, CI state, `needs-human-review`).
   - Done yesterday · In progress (with PR/CI state) · Next up (what autopilot will pick and why — respect blockers/links) ·
     Blockers/risks.
