#!/usr/bin/env node
/**
 * Seed Ruflo memory from the engineering knowledge base.
 *
 *   node scripts/ruflo-seed.mjs                 # all docs/context/*.md
 *   node scripts/ruflo-seed.mjs docs/context/auth-rbac.md
 *   node scripts/ruflo-seed.mjs --dry-run
 *
 * Namespaces:
 *   nexlegtiq-spec  one entry per "## section" of each docs/context file (key: <file>#<section-slug>)
 *   decisions       one entry per D-### in decisions.md (key: D-###)
 * Re-running is safe: entries are upserted by key.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter((a) => !a.startsWith('--'));
const ctxDir = join(process.cwd(), 'docs', 'context');
const targets = files.length
  ? files
  : readdirSync(ctxDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(ctxDir, f));

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

function store(namespace, key, value) {
  if (dryRun) {
    console.log(`[dry-run] ${namespace} :: ${key} (${value.length} chars)`);
    return true;
  }
  const r = spawnSync(
    'npx',
    ['-y', 'ruflo@latest', 'memory', 'store', '--namespace', namespace, '--key', key, '--value', value],
    { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' },
  );
  if (r.status !== 0) {
    console.error(`✗ ${namespace} :: ${key}\n${r.stderr?.toString() ?? ''}`);
    return false;
  }
  console.log(`✓ ${namespace} :: ${key}`);
  return true;
}

let ok = 0;
let failed = 0;
for (const file of targets) {
  const name = basename(file, '.md');
  const text = readFileSync(file, 'utf8');

  if (name === 'decisions') {
    const entries = text.split(/\n(?=\*\*D-\d{3})/).filter((e) => /^\*\*D-\d{3}/.test(e));
    for (const e of entries) {
      const id = e.match(/^\*\*(D-\d{3})/)[1];
      (store('decisions', id, e.trim()) ? ok++ : failed++);
    }
    continue;
  }

  const sections = text.split(/\n(?=## )/);
  const intro = sections.shift() ?? '';
  const title = (intro.match(/^# (.+)$/m) ?? [])[1] ?? name;
  if (intro.trim()) (store('nexlegtiq-spec', `${name}#intro`, intro.trim()) ? ok++ : failed++);
  for (const s of sections) {
    const heading = (s.match(/^## (.+)$/m) ?? [])[1] ?? 'section';
    const value = `[${title}] (docs/context/${name}.md)\n${s.trim()}`;
    (store('nexlegtiq-spec', `${name}#${slug(heading)}`, value) ? ok++ : failed++);
  }
}
console.log(`\nDone: ${ok} stored, ${failed} failed${dryRun ? ' (dry run)' : ''}.`);
if (!dryRun && ok > 0) console.log('Tip: build the HNSW index once: npx ruflo@latest memory search -q "tenant isolation" --build-hnsw');
process.exit(failed ? 1 : 0);
