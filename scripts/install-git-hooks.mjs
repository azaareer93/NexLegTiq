#!/usr/bin/env node
/**
 * Installs the NexLegTiq git hooks of this clone (docs/tooling.md#7-after-a-merge).
 *
 *   pnpm hooks:install   (also run by `pnpm install`, as `prepare`)
 *
 * Each hook in scripts/git-hooks/ is a block between `# <name>-start` / `# <name>-end` markers. The block is added to, or
 * replaced inside, .git/hooks/<hook>, so hooks written by other tools (graphify's post-commit/post-checkout) are kept.
 * Idempotent: re-run after pulling a change to scripts/git-hooks/.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `pnpm install` runs this (`prepare`): nothing to install in CI or outside a git clone (a tarball, a Docker build).
if (process.env.CI) process.exit(0);
let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  process.exit(0);
}
// --git-common-dir: worktrees share the main clone's hooks.
const hooksDir = resolve(
  root,
  execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(),
  'hooks',
);
const sourceDir = join(root, 'scripts', 'git-hooks');

for (const hook of readdirSync(sourceDir)) {
  const block = readFileSync(join(sourceDir, hook), 'utf8').trim();
  const [, marker] = /^# (\S+)-start/.exec(block) ?? [];
  if (!marker) throw new Error(`${hook}: first line must be "# <name>-start"`);

  const target = join(hooksDir, hook);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '#!/bin/sh\n';
  const pattern = new RegExp(String.raw`# ${marker}-start[\s\S]*?# ${marker}-end\n?`);
  const next = pattern.test(current)
    ? current.replace(pattern, () => `${block}\n`)
    : `${current.trimEnd()}\n\n${block}\n`;

  if (/^\s*exec\s/m.test(current.replace(pattern, ''))) {
    // A hook that ends in `exec …` replaces the shell: a block appended after it would never run.
    console.warn(
      `${hook}: another tool's hook uses exec; check that the ${marker} block still runs (${target})`,
    );
  }
  writeFileSync(target, next);
  chmodSync(target, 0o755);
  console.info(`${pattern.test(current) ? 'updated' : 'installed'} ${hook} (${target})`);
}
