---
description: Sync knowledge between Notion (intent) and docs/context (engineering digest) in either direction.
argument-hint: "pull <topic|all> | decisions | push <topic>"
---
Sync with Notion: $ARGUMENTS (root page `361fd30cf06d818183deda87a78c8d7a`; page links in `docs/context/00-index.md`).

- `pull <topic|all>`: fetch the Notion pages linked for that topic (`notion-fetch`), diff against the digest, update the
  `docs/context/*.md` file(s). New conflicts → propose `D-###` entries (don't silently overwrite decisions). Re-seed Ruflo for changed
  files: `node scripts/ruflo-seed.mjs --export=<scratchpad>/ruflo-changed.json --changed-since=HEAD <file>` before committing, then
  `memory_store` each exported entry (never the direct seed inside a session). Commit as `docs(context): sync <topic> from Notion`.
- `decisions`: update the Notion page **"Engineering Decision Log"** (child of the root) to mirror `docs/context/decisions.md`
  (create it if missing): fetch the page first and add or update only the entries it lacks or that changed, in its plain-language
  summary style. Notion is where the owner reads; the repo remains canonical. Then record what was synced:
  `mkdir -p .git/nexlegtiq && git rev-parse HEAD:docs/context/decisions.md > .git/nexlegtiq/notion-decisions` (/ticket step 0 reads it).
- `push <topic>`: when implementation changed behavior, add a dated "Implementation notes" callout at the top of the relevant
  Notion page summarizing the change and linking the PR — never rewrite the original spec text.
