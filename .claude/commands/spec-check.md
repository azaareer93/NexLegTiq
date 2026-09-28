---
description: Check a ticket, file or area against the Notion-derived specs and decisions; report gaps and conflicts.
argument-hint: "MVP-123 | path | topic"
---
Spec-check **$ARGUMENTS** using the `spec-guardian` subagent:
- If a Jira key: compare its description/AC with `docs/context/*` and `decisions.md`; list missing AC (i18n, RBAC, tenant, audit,
  errors, tests), contradictions, and suggest improved AC. Offer to update the ticket (`editJiraIssue`) — do it if I agree or if only
  additive (APEX mode: additive fixes are applied directly, then reported).
- If a path/area: compare implementation with the specs; list deviations with file:line, classify as *bug*, *undocumented decision*
  (propose `D-###`), or *spec is outdated* (propose doc update).
- If a topic: summarize what the specs say, with links to the Notion sources from `00-index.md`.
