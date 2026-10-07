#!/usr/bin/env node
// PreToolUse(Bash): stop destructive or policy-violating shell commands.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, block } from './read-input.mjs';

const input = await readInput();
const cmd = String(input?.tool_input?.command ?? '');
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// Split on shell separators so each sub-command is checked on its own.
const parts = cmd.split(/&&|\|\||;|\n/).map((s) => s.trim());

const localDb = () => {
  const envFile = join(root, '.env');
  if (!existsSync(envFile)) return false;
  const m = readFileSync(envFile, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)/m);
  return !!m && /@(localhost|127\.0\.0\.1|postgres|db)(:\d+)?\//.test(m[1]);
};

for (const p of parts) {
  if (/^git\s+push\b/.test(p)) {
    if (/\s(--force|-f)(\s|$)/.test(p))
      block(
        `force-push is not allowed; use --force-with-lease on your own branch\n  command: ${p}`,
      );
    if (/\s(\S+:)?(main|develop)(\s|$)/.test(p))
      block(`direct pushes to main/develop are not allowed; open a PR (/ship)\n  command: ${p}`);
  }
  if (/\bprisma\s+migrate\s+reset\b/.test(p) && !localDb()) {
    block('prisma migrate reset is only allowed when .env DATABASE_URL points at a local database');
  }
  if (/\bprisma\s+db\s+push\b/.test(p)) block('use migrations (prisma migrate dev), not db push');
  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|~|\$HOME|\.|\*)(\s|$)/.test(p))
    block(`refusing recursive delete of root/home/cwd\n  command: ${p}`);
  if (/\b(DROP\s+DATABASE|DROP\s+SCHEMA|TRUNCATE\s+TABLE)\b/i.test(p))
    block('destructive SQL must be run manually by the owner');
  if (/^git\s+reset\s+--hard\s+origin\/(main|develop)\b/.test(p))
    block('hard reset to shared branches must be done manually');
  if (
    /\b(cat|less|head|tail|more|bat)\s+(\S*\/)?\.env(\.(local|production|staging|prod))?(\s|$)/.test(
      p,
    )
  ) {
    block('do not print real .env files (use .env.example)');
  }
}
if (/(curl|wget)\s[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(cmd))
  block('piping remote scripts to a shell is not allowed from the agent (ask the owner)');
process.exit(0);
