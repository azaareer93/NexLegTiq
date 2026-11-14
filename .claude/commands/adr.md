---
description: Record a new engineering decision (D-###) as docs/context/decisions/D-###.md and Ruflo memory.
argument-hint: "<short title> — <decision>"
---
Record a decision: $ARGUMENTS

1. Next free number `D-###` = one above the highest of `ls docs/context/decisions` and of the decisions in my open PRs
   (`gh pr list --author @me --state open` → their `docs/context/decisions/` files).
2. Write `docs/context/decisions/D-###.md` with the entry: `**D-### — Title** · Accepted (YYYY-MM-DD, MVP-<n> if on a ticket branch)` + conflict/context → decision · why.
   If it supersedes an earlier one, mark the old file's status `Superseded by D-###` (don't delete it).
3. Update any topic file in `docs/context/` that the decision changes.
4. Store in Ruflo: `memory_store` namespace `decisions`, key `D-###`, value = one-paragraph summary.
5. Tell me whether the Notion page(s) need updating; `/sync-notion decisions` pushes the log.
