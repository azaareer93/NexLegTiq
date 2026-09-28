---
description: Save a durable project learning to Ruflo memory (and CLAUDE.md/rules if it's a rule).
argument-hint: "<what to remember>"
---
Remember: $ARGUMENTS

- If it is a **rule everyone must follow** → add it to the most specific place: `.claude/rules/<area>.md` (path-scoped) or CLAUDE.md
  non-negotiables (keep CLAUDE.md short). If it is a decision → use `/adr` instead.
- If it is a **pattern, gotcha, or fact** → `memory_store` in Ruflo: namespace `patterns` (how we do X), `lessons` (what went wrong/why),
  or `nexlegtiq-spec` (product facts), with a descriptive kebab key and a self-contained value (include file paths and ticket key).
- Confirm what was stored and where.
