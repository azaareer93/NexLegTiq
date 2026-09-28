---
description: Groom the Jira backlog — create or refine stories for an epic/feature with proper AC, labels and links.
argument-hint: "<epic key | feature description>"
---
Groom: $ARGUMENTS — follow the `jira-workflow` skill (story template, labels, links).

1. Read the epic (or find it by summary) and its children; read the relevant `docs/context/` files.
2. Identify missing stories (spec coverage), oversized stories (> ~3 days → split), and weak AC.
3. Create/edit issues directly (APEX mode) using the story template: user story line, context with Notion link, Acceptance Criteria
   (Given/When/Then, incl. RBAC, tenant, i18n AR/EN, audit, errors), Out of scope, Tech notes, Test notes. Parent = epic.
4. Add "Blocks" links for true dependencies. Labels: `phase-N`, area labels, `slice-N` if scheduled.
5. Report created/updated keys in a compact table.
