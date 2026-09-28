---
description: Sync knowledge between Notion (intent) and docs/context (engineering digest) in either direction.
argument-hint: "pull <topic|all> | decisions | push <topic>"
---
Sync with Notion: $ARGUMENTS (root page `361fd30cf06d818183deda87a78c8d7a`; page links in `docs/context/00-index.md`).

- `pull <topic|all>`: fetch the Notion pages linked for that topic (`notion-fetch`), diff against the digest, update the
  `docs/context/*.md` file(s). New conflicts → propose `D-###` entries (don't silently overwrite decisions). Re-seed Ruflo for changed
  files (`scripts/ruflo-seed.sh <file>`). Commit as `docs(context): sync <topic> from Notion`.
- `decisions`: update the Notion page **"Engineering Decision Log"** (child of the root) to mirror `docs/context/decisions.md`
  (create it if missing). Notion is where the owner reads; the repo remains canonical.
- `push <topic>`: when implementation changed behavior, add a dated "Implementation notes" callout at the top of the relevant
  Notion page summarizing the change and linking the PR — never rewrite the original spec text.
