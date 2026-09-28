---
description: Daily status from Jira + git — what moved, what's in progress, what's next, blockers.
---
Build a short standup for project MVP:
1. JQL via Atlassian MCP: `project = MVP AND updated >= -1d ORDER BY updated DESC`, plus `status = "In Progress"` and
   the top 5 of `status = "To Do" AND labels = slice-1 ORDER BY rank` (fall back to priority if no rank).
2. `git log --since=yesterday --oneline --all` and open PRs (`gh pr list`).
3. Output: Done yesterday · In progress (with PR/CI state) · Next up (recommended next ticket and why — respect blockers/links) ·
   Blockers/risks. Keep it under 15 lines.
