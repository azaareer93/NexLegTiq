#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit): format the touched file with the repo's Prettier (never blocks).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readInput } from './read-input.mjs';

const input = await readInput();
const file = String(input?.tool_input?.file_path ?? '');
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const prettier = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
);
if (
  file &&
  existsSync(file) &&
  existsSync(prettier) &&
  /\.(ts|tsx|js|mjs|cjs|json|md|scss|css|ya?ml|prisma)$/.test(file) &&
  !/\.prisma$/.test(file)
) {
  spawnSync(prettier, ['--write', '--log-level', 'warn', file], {
    stdio: 'ignore',
    timeout: 20000,
  });
}
if (file.endsWith('.prisma') && existsSync(join(root, 'node_modules', '.bin', 'prisma'))) {
  spawnSync(join(root, 'node_modules', '.bin', 'prisma'), ['format', `--schema=${file}`], {
    stdio: 'ignore',
    timeout: 20000,
  });
}
process.exit(0);
