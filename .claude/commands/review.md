---
description: Multi-angle review of the current branch vs develop (quality, security/tenancy, tests, RTL/i18n, spec fit).
argument-hint: "[optional focus]"
---
Review the current branch against `origin/develop` (`git diff origin/develop...HEAD`). Focus: $ARGUMENTS

Run these reviews **in parallel** as subagents, each given the diff, the Jira key from the branch name, and `docs/context/`:
- `code-reviewer` — correctness, design, naming, complexity, dead code, error codes, envelope, performance (N+1, missing indexes, pagination).
- `security-auditor` — tenant isolation, RBAC decorators vs matrix, input validation, secrets/logging, uploads/downloads, AI PII.
- `qa-engineer` — test coverage at the right layers, missing cross-tenant/permission/validation cases, flaky patterns.
- `rtl-i18n-reviewer` — only if FE files changed: literal strings, missing `ar`/`en` keys, physical CSS, bidi, glossary terms.
- `spec-guardian` — acceptance criteria of the ticket and consistency with `decisions.md`; flags undocumented decisions.

Then consolidate: deduplicate, verify each finding against the code (drop false positives), rank **Blocker / Should-fix / Nit**,
and list them with file:line and a concrete fix. Apply all Blockers and Should-fix items unless one needs my decision; re-run
`pnpm nx affected -t lint typecheck test`. Report remaining items briefly.
