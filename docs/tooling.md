# Claude Code add-ons

Decision: **D-077** (`docs/context/decisions.md`). Project rules always win over plugin skills (CLAUDE.md → "Precedence").

| Add-on | What it does | Status here | Where it lives |
|---|---|---|---|
| [claude-code-setup](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup) | Official Anthropic plugin. Scans the repo and recommends hooks/skills/MCP/subagents. Read-only. | **Enabled for everyone** | `.claude/settings.json` → `enabledPlugins` |
| [Ponytail](https://github.com/DietrichGebert/ponytail) | "Lazy senior dev" mode: YAGNI, stdlib first, smallest working change. Adds `/ponytail*` commands and SessionStart/SubagentStart/UserPromptSubmit hooks. | **Enabled for everyone** | marketplace `ponytail` |
| [Agent Skills](https://github.com/addyosmani/agent-skills) | 25 lifecycle skills (spec, TDD, review, security, perf, ship). No hooks. | **Enabled for everyone** | marketplace `addy-agent-skills` |
| [task-observer](https://github.com/rebelytics/one-skill-to-rule-them-all) | Meta-skill: logs corrections and repeated work, proposes skill improvements for review. | **Project skill** (vendored, CC BY 4.0) | `.claude/skills/task-observer/`, activation `.claude/rules/task-observer.md` |
| [Graphify](https://github.com/Graphify-Labs/graphify) | Local tree-sitter knowledge graph of the code; `graphify query` answers "how is X wired" with far fewer tokens than grep. | **Per machine**, one-time wiring | `graphify-out/`, hooks in `.claude/settings.local.json` (all git-ignored) |
| [Headroom](https://github.com/headroomlabs-ai/headroom) | Local proxy that compresses tool output/logs before they reach the model. | **Optional, per machine** | your shell only |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Automatic session memory (5 hooks + Bun worker, AI-compressed observations). | **Optional, per machine**. Not recommended now. | `~/.claude-mem` |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Gateway routing Claude Code to 300+ providers / free tiers. | **Not used for this repo** | — |

## 1. Enabled plugins (automatic)
After pulling this branch, open the repo in Claude Code and **trust the folder**. Claude Code then adds the two marketplaces
and enables the three plugins. Check with `/plugin`. If you don't get a prompt, install them manually (send each line as its own prompt):
```
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
/plugin marketplace add addyosmani/agent-skills
/plugin install agent-skills@addy-agent-skills
/plugin install claude-code-setup@claude-plugins-official
```
(If `claude-plugins-official` is unknown: `/plugin marketplace add anthropics/claude-plugins-official` first.)

Notes
- **Ponytail** may offer to add a statusline to your *user* `~/.claude/settings.json`. That's optional. It also writes
  `~/.claude/.ponytail-active` and `%APPDATA%\ponytail\config.json`. Before uninstalling, run `node scripts/uninstall.js`
  from the plugin folder. It needs `node` on PATH (already true here).
- **Agent Skills** overlaps our `/review`, `/ship`, `/spec-check` and `/adr`. Project commands win on name clashes. Plugin
  commands stay reachable under their plugin prefix. Its git skill recommends trunk-based development; we keep D-070.
- **claude-code-setup**: after a big structural change, ask "recommend automations for this project". Treat the answers as
  proposals and record the ones we adopt with `/adr`.

## 2. task-observer
The skill is already in the repo. The activation instructions load every session from `.claude/rules/task-observer.md`.
- Observations are written **outside the repo**, to `~/.claude/task-observer/nexlegtiq` (Windows:
  `%USERPROFILE%\.claude\task-observer\nexlegtiq`). Override with the `NEXLEGTIQ_OBSERVER_DIR` user env var.
- The first writes there ask for permission. Choose "always allow" for that folder.
- Cloud sessions have no persistent home, so they report observations in the final message and write no log.
- Weekly: ask Claude "run the task-observer weekly review". Approved skill changes go through a normal `MVP-<n>` branch + PR.
- **Verify activation in a new session.** Before any work, the first tool call should be the task-observer skill. After a
  few sessions, `skill-observations/observation-log/` should exist.
- Optional hardening, owner to apply: have `.claude/hooks/session-start.mjs` inject the pinned path and the open-observation
  count (the "harness hook" tier in the skill's `references/environments.md`). That change to our hook was left to you
  because hooks are security-relevant config.
- To update: re-copy `SKILL.md`, `references/`, `scripts/` from upstream and bump `UPSTREAM.md`.

## 3. Graphify (once per machine, now that code exists)
Requires Python ≥3.10 and `uv`. **Windows (PowerShell) prerequisites, once:**
```powershell
winget install --id astral-sh.uv -e   # or: pip install uv
uv tool update-shell                  # puts %USERPROFILE%\.local\bin on PATH (where graphify/headroom land)
# close ALL terminals and Claude Code, reopen, then check:
graphify --help                       # must resolve, or the hooks Graphify adds will fail on every Read/Grep/Bash
```
Claude Code on Windows runs its Bash tool and hooks through Git Bash, so `graphify` must be on the Windows user PATH, not
just in the current PowerShell session.

Then **in the repo folder** (a freshly opened terminal starts in your home folder — `cd` first, otherwise Graphify writes
`CLAUDE.md` and `.claude\settings.json` into your *home* folder, and the latter is your user-wide Claude settings):
```powershell
cd C:\Projects\NexLegTiq
uv tool install graphifyy           # note the double y
graphify extract . --code-only      # local AST only: no LLM calls, nothing leaves the machine
graphify claude install --project   # writes CLAUDE.md section, 2 PreToolUse hooks, .claude/CLAUDE.md, .claude/skills/graphify/
graphify hook install               # post-commit/post-checkout git hooks keep the graph fresh
```
Expected output ends with `graphify section written to …\NexLegTiq\CLAUDE.md` and
`.claude/settings.json -> PreToolUse hooks registered`. Then **move the wiring to machine-local files** — the hooks run
`graphify hook-guard`, which doesn't exist in cloud sessions or on machines without Graphify, so they must not be committed:
```powershell
git checkout -- CLAUDE.md .claude/settings.json      # our committed files stay as they are
Remove-Item .claude\settings.json.graphify-bak
```
Create `.claude\settings.local.json` (git-ignored; if it already exists, add the two entries to its `hooks.PreToolUse`):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Grep", "hooks": [{ "type": "command", "command": "graphify hook-guard search", "timeout": 10 }] },
      { "matcher": "Read|Glob", "hooks": [{ "type": "command", "command": "graphify hook-guard read", "timeout": 10 }] }
    ]
  }
}
```
Our guard hooks in `.claude/settings.json` still run; local hooks are added alongside them, not instead. Graphify's
generated `.claude/CLAUDE.md` pointer and `.claude/skills/graphify/` stay on your machine (git-ignored). The committed
CLAUDE.md already tells Claude to use `graphify query` when `graphify-out/graph.json` exists.
`graphify claude uninstall` also cleans `settings.local.json`.

- Keep `--code-only`. `docs/context` is already in Ruflo and CLAUDE.md, and a semantic pass over docs would spend model credits.
- `graphify-out/` is git-ignored because each machine rebuilds it. Use `graphify query "..."`, `graphify path A B`,
  `graphify affected X`.
- In PowerShell type `graphify .`, not `/graphify .`.

## 4. Headroom (optional, per machine)
Saves tokens on long logs and test output. Everything runs locally (Apache-2.0). Compression is lossy, so if Claude seems
to miss a detail in a log, run that session unwrapped.
```powershell
uv tool install --python 3.13 "headroom-ai[all]"
setx HEADROOM_BEACON off            # disable the anonymous usage beacon; takes effect in NEW terminals only
headroom wrap claude                # start Claude Code through the local proxy; undo: headroom unwrap claude
```
Don't commit anything that sets `ANTHROPIC_BASE_URL`. The proxy is a personal choice, not a project default.

## 5. claude-mem (optional; not recommended now)
It would be a second memory system next to Ruflo (curated `decisions` / `patterns` / `lessons`) and Claude Code's own
memory. Both would inject context at SessionStart, which duplicates tokens and can surface stale or conflicting facts.
It also runs an AI compression step on tool events, which costs tokens.
If you still want it: `npx claude-mem install`, pick your own Anthropic plan as the provider, **skip the hosted-observer
sign-in/subscription**, and wrap anything sensitive in `<private>…</private>`. Remove it with its uninstaller if the
SessionStart context gets noisy.

## 6. OmniRoute (not used)
It replaces Claude Code's model endpoint with a gateway to many providers and pooled free tiers. For this repo that
means:
- weaker or unknown models writing auth, tenancy and money code;
- source code sent to providers without zero-retention terms;
- provider-by-provider terms-of-service exposure.

Headroom gives the token savings without changing the model. The product's own AI calls are a separate question, covered by
D-057 and MVP-83.
