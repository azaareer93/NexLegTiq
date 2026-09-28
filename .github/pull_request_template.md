## Summary
<!-- What and why, 2–4 lines -->

**Jira:** https://nexlegtiq.atlassian.net/browse/MVP-
**Decisions:** <!-- D-### added/changed, or "none" -->

## Acceptance criteria
- [ ] <!-- copy from ticket; tick with evidence (test name, screenshot, curl) -->

## Checklist (Definition of Done)
- [ ] Tests at the right layers; coverage gate green
- [ ] Tenant isolation test for new tenant endpoints (cross-office → 404)
- [ ] RBAC matches `packages/shared-types/src/permissions.ts`
- [ ] i18n keys in **ar** and **en**, RTL checked (screenshots below)
- [ ] Audit/timeline events for case-data changes
- [ ] Swagger/contracts updated; error codes documented
- [ ] Migrations reviewed (label `needs-human-review`)
- [ ] `docs/context` / `decisions.md` updated if behavior changed

## Screenshots (AR / EN)

## Migration / rollout / rollback
