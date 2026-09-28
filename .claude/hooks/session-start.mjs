#!/usr/bin/env node
// SessionStart: inject branch/ticket context so every session starts oriented.
import { execSync } from 'node:child_process';

const sh = (c) => {
  try {
    return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
const branch = sh('git rev-parse --abbrev-ref HEAD') || '(no commits yet)';
const key = (branch.match(/MVP-\d+/) ?? [])[0];
const dirty = sh('git status --porcelain').split('\n').filter(Boolean).length;
const lines = [
  `NexLegTiq session context:`,
  `- Branch: ${branch}${dirty ? ` (${dirty} uncommitted changes)` : ''}`,
  key
    ? `- Active Jira ticket: ${key} — https://nexlegtiq.atlassian.net/browse/${key} (load details with /ticket ${key} if not in context)`
    : `- No ticket branch. Start work with /ticket MVP-<n>; see next-up with /standup.`,
  `- Knowledge: docs/context/00-index.md; decisions (canonical) are imported via CLAUDE.md.`,
  `- Memory: search Ruflo (memory_search) for patterns/lessons before designing; save learnings with /remember.`,
];
process.stdout.write(lines.join('\n') + '\n');
