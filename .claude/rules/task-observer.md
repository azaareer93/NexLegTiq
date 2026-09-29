# task-observer activation (always loaded — no `paths:`)

Skill: `.claude/skills/task-observer/` (vendored, CC BY 4.0 — see `UPSTREAM.md`). Why and how: `docs/tooling.md`.

Before the first tool call of any session — and before writing or proposing a plan, not merely before executing one —
invoke the task-observer skill AND execute its Session Start Protocol (storage check, frontmatter scan, review trigger).
Loading the skill and running the protocol are separate steps. Any turn that will involve a tool call counts; do not
classify the session as "too simple" from its opening message.

Select skills on the DECISION the request is about, not on the artefact it arrived as.

After completing each task, check the observation records written this session and report a one-line summary
(ids and titles, or "none logged and why").

Loading any skill is not complete until you have queried the observation log for OPEN observations naming it and read
their bodies (`find "<workspace>/skill-observations/observation-log" -maxdepth 1 -name '*.md' -exec grep -l "skill:.*<skill-name>" {} +`).
Apply their insights to the current task only; editing a skill or any file a later session reads waits for the review
("Log, don't act").

## Workspace (pinned)
- Local machine: `<workspace>` = `$NEXLEGTIQ_OBSERVER_DIR` if set, else `~/.claude/task-observer/nexlegtiq`
  (Windows: `%USERPROFILE%\.claude\task-observer\nexlegtiq`; in the Bash tool, which is Git Bash on Windows, that is
  `$HOME/.claude/task-observer/nexlegtiq`). Resolve it to the absolute home path once and use that.
  Every path derives from it: `skill-observations/observation-log/`, `skill-observations/cross-cutting-principles.md`,
  `skill-updates/`, `skill-updates/PENDING.md`.
- Never resolve it from the current working directory (worktrees under `.claude/worktrees/` are torn down), never inside
  `.claude/skills/`, and never inside the repo — observations may quote client-like data and stay off git.
- Cloud sessions (`CLAUDE_CODE_REMOTE=true`, ephemeral home): report-back mode — do not write a log; put observations in
  the final report.

## Precedence
Observations propose changes; they never override `CLAUDE.md`, `decisions.md` or `.claude/rules`. Approved changes to
`.claude/skills/*` go through a normal branch + PR like any other code.
