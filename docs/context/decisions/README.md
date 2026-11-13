# Decision Log (ADR-lite)

Canonical resolutions of conflicts found across the Notion documentation (read 2026-09-28) and every engineering call made
since. **One file per decision**, `D-NNN.md` (D-170). When code, a Jira ticket, or a Notion page disagrees with a decision,
**the decision wins** until a newer one supersedes it. Never rewrite history — mark superseded entries instead
(`Superseded by D-###`) and put new facts in a new file or the entry's "Review additions".

Format of each file: `**D-NNN — Title** · Status · Source of conflict → Decision · Why.`

- **Find** the decisions of an area: `grep -ril '<topic>' docs/context/decisions` (or `grep -l 'D-082' …` for links).
- **Add** one: the next number after the highest file here **and** in your open PRs; a new file, never an edit of
  another ticket's file. Two branches that pick the same number collide as an add/add conflict — renumber the later one.
- Numbers are ids: gaps are fine (D-097 parallel tickets), the order of files is the order of numbers.
