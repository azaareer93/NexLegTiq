---
name: jira-workflow
description: How NexLegTiq work is tracked in Jira (project MVP on nexlegtiq.atlassian.net) — issue types, story template, labels, links, statuses, branch/PR naming, and which Atlassian MCP calls to use. Use whenever reading, creating, grooming, or transitioning Jira issues.
---
# Jira workflow — project MVP

- Site `nexlegtiq.atlassian.net`, cloudId `9cb815a7-782c-46e9-a4ca-74b3977b88f4`, project key `MVP` (id 10001), Kanban board 2.
- Issue types: Epic `10005` · Story `10008` · Task `10007` · Subtask `10006`. Stories/Tasks set `parent` = epic key.
- Epics = product modules (see `docs/jira/backlog.md` for the map). Phase 2–5 epics are placeholders until groomed.

## Labels
`phase-1` (MVP) … `phase-5` · area: `backend`, `frontend`, `portal`, `admin`, `infra`, `ai`, `security`, `i18n`, `data` ·
scheduling: `slice-1`, `slice-2`, … (Kanban has no sprints — slices are the ordered delivery batches) · `needs-decision`, `tech-debt`, `bug`.

## Story template (description, markdown)
```
**As a** <persona/role> **I want** <capability> **so that** <outcome>.

### Context
<1–3 lines>. Spec: <Notion link>. Digest: docs/context/<file>.md#<anchor>. Decisions: D-###.

### Acceptance criteria
- [ ] Given … when … then …
- [ ] RBAC: <who can / cannot> (403 AUTH-100); other office → 404
- [ ] Validation errors return VAL-* with field details; UI shows localized messages
- [ ] AR + EN strings, RTL verified
- [ ] Audit/timeline events: …

### Out of scope
### Tech notes
### Test notes
```
Estimates via labels are not used; split anything bigger than ~3 dev-days.

## Statuses & transitions
To Do → In Progress (on `/ticket`) → In Review (on `/ship`, if the workflow has it; else keep In Progress and comment) → Done (after merge
to develop; the GitHub-for-Jira integration can auto-transition on merge). Always call `getTransitionsForJiraIssue` first — never
hard-code transition ids.

## Linking
- Dependencies: issue link type "Blocks". Check `issuelinks` before starting.
- Code: branch `MVP-<n>-<slug>`, commits `Refs: MVP-<n>`, PR title `[MVP-<n>] type(scope): subject` → Jira dev panel links automatically
  when the GitHub for Jira app is installed.
- Decisions: mention `D-###` in the ticket comment when a decision was made on it.

## Useful JQL
- Next up: `project = MVP AND statusCategory = "To Do" AND labels = slice-1 ORDER BY rank`
- My WIP: `project = MVP AND status = "In Progress" AND assignee = currentUser()`
- Epic children: `parent = MVP-<epic>`
- Needs decision: `project = MVP AND labels = needs-decision AND statusCategory != Done`

## MCP calls (Atlassian Rovo)
`getJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue` (projectKey MVP, issueTypeName, summary, description markdown,
additional_fields {parent: {key}, labels: [...]}), `editJiraIssue`, `getTransitionsForJiraIssue`, `transitionJiraIssue`,
`addCommentToJiraIssue`, `createIssueLink` (type "Blocks"), `lookupJiraAccountId`.
