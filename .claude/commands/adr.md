---
description: Record a new engineering decision (D-###) in docs/context/decisions.md and Ruflo memory.
argument-hint: "<short title> — <decision>"
---
Record a decision: $ARGUMENTS

1. Read `docs/context/decisions.md`, find the right section and next free number `D-###`.
2. Append an entry: `**D-### — Title** · Accepted (YYYY-MM-DD, MVP-<n> if on a ticket branch)` + conflict/context → decision · why.
   If it supersedes an earlier one, mark the old entry `Superseded by D-###` (don't delete it).
3. Update any topic file in `docs/context/` that the decision changes.
4. Store in Ruflo: `memory_store` namespace `decisions`, key `D-###`, value = one-paragraph summary.
5. Tell me whether the Notion page(s) need updating; `/sync-notion decisions` pushes the log.
