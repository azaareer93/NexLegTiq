#!/usr/bin/env node
/**
 * Seed Ruflo memory from the engineering knowledge base.
 *
 *   node scripts/ruflo-seed.mjs                 # all docs/context/*.md
 *   node scripts/ruflo-seed.mjs docs/context/auth-rbac.md
 *   node scripts/ruflo-seed.mjs --dry-run
 *
 * Run from the repo root (Ruflo keeps its memory DB relative to the working directory).
 *
 * Namespaces:
 *   nexlegtiq-spec  one entry per "## section" of each docs/context file (key: <file>#<section-slug>)
 *   decisions       one entry per D-### in decisions.md (key: D-###)
 * Re-running is safe: `memory store` upserts by (namespace, key).
 *
 * Why no `npx` / shell: values are multi-line markdown containing `|`, `<`, `>`, `&` and quotes.
 * On Windows `npx` is a .cmd shim that must run through cmd.exe, which treats those as operators and cannot
 * carry newlines inside an argument. So we locate Ruflo's JS entry (bin/ruflo.js) and run it with
 * `node` directly — arguments are then passed verbatim on every OS.
 *
 * Ruflo entry resolution order:
 *   1. RUFLO_BIN env var (path to ruflo's bin/ruflo.js)
 *   2. local cache  .claude-flow/seed-cli/node_modules/ruflo   (git-ignored)
 *   3. global install (`npm root -g`)/ruflo
 *   4. otherwise installs ruflo@latest into the local cache once
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const files = args.filter((a) => !a.startsWith('--'));
const root = process.cwd();
const ctxDir = join(root, 'docs', 'context');
const isWin = process.platform === 'win32';

if (!existsSync(ctxDir)) {
  console.error('Run this from the repository root (docs/context not found).');
  process.exit(1);
}

const targets = files.length
  ? files.map((f) => resolve(f))
  : readdirSync(ctxDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(ctxDir, f));

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/** Resolve ruflo's JS entry from an installed package directory. */
function binFromPkgDir(pkgDir) {
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return null;
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ruflo ?? Object.values(pkg.bin ?? {})[0];
  const bin = rel ? join(pkgDir, rel) : null;
  return bin && existsSync(bin) ? bin : null;
}

function npm(argv, opts = {}) {
  // npm is also a .cmd shim on Windows; only fixed, metachar-free arguments are passed here.
  return spawnSync(isWin ? 'npm.cmd' : 'npm', argv, { encoding: 'utf8', shell: isWin, ...opts });
}

function resolveRufloBin() {
  if (process.env.RUFLO_BIN) {
    if (existsSync(process.env.RUFLO_BIN)) return process.env.RUFLO_BIN;
    console.error(`RUFLO_BIN points to a missing file: ${process.env.RUFLO_BIN}`);
    process.exit(1);
  }
  const cacheDir = join(root, '.claude-flow', 'seed-cli');
  const local = binFromPkgDir(join(cacheDir, 'node_modules', 'ruflo'));
  if (local) return local;

  const g = npm(['root', '-g']);
  if (g.status === 0) {
    const globalBin = binFromPkgDir(join(g.stdout.trim(), 'ruflo'));
    if (globalBin) return globalBin;
  }

  console.log('Installing ruflo@latest into .claude-flow/seed-cli (one-time, may take a minute)…');
  mkdirSync(cacheDir, { recursive: true });
  const inst = npm(['install', '--prefix', cacheDir, 'ruflo@latest', '--no-audit', '--no-fund', '--loglevel=error'], {
    stdio: 'inherit',
  });
  const installed = inst.status === 0 && binFromPkgDir(join(cacheDir, 'node_modules', 'ruflo'));
  if (!installed) {
    console.error('Could not install ruflo. Install it globally (npm i -g ruflo) or set RUFLO_BIN, then re-run.');
    process.exit(1);
  }
  return installed;
}

// Ruflo on Windows writes with sql.js (native SQLite bridge disabled upstream, ruflo #3024) and refuses to write
// while WAL sidecar files exist — they mean another process (usually Claude Code's claude-flow MCP server) has the
// DB open natively, or a crashed process left them behind. Detect that up front instead of failing every entry.
const memoryRoot = process.env.CLAUDE_FLOW_MEMORY_PATH ? resolve(process.env.CLAUDE_FLOW_MEMORY_PATH) : join(root, '.swarm');
const sidecars = ['memory.db-wal', 'memory.db-shm'].map((f) => join(memoryRoot, f)).filter((f) => existsSync(f));
if (!dryRun && sidecars.length) {
  console.error(
    [
      'Ruflo memory DB is open by another process (found WAL sidecar files):',
      ...sidecars.map((f) => `  ${f}`),
      '',
      'Fix:',
      '  1. Close Claude Code (and any other terminal running `ruflo mcp start` / the ruflo daemon).',
      '  2. Re-run this script.',
      '  3. If the files are still there with nothing running, they are stale leftovers — move them aside, e.g.',
      isWin
        ? `     Move-Item ${join(memoryRoot, 'memory.db-wal')} ${join(memoryRoot, 'memory.db-wal.bak')}; Move-Item ${join(memoryRoot, 'memory.db-shm')} ${join(memoryRoot, 'memory.db-shm.bak')}`
        : `     mv ${join(memoryRoot, 'memory.db-wal')}{,.bak} && mv ${join(memoryRoot, 'memory.db-shm')}{,.bak}`,
      '     (if the move fails with "in use", a process still holds the DB — find and close it first).',
    ].join('\n'),
  );
  process.exit(2);
}

const rufloBin = dryRun ? null : resolveRufloBin();
if (rufloBin) console.log(`Using ${rufloBin}\n`);

function store(namespace, key, value) {
  if (dryRun) {
    console.log(`[dry-run] ${namespace} :: ${key} (${value.length} chars)`);
    return true;
  }
  const r = spawnSync(
    process.execPath,
    [rufloBin, 'memory', 'store', '--namespace', namespace, '--key', key, '--value', value, '--tags', 'nexlegtiq,seed'],
    { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error || r.status !== 0 || /\[ERROR\]|error:/i.test(r.stderr ?? '')) {
    console.error(`✗ ${namespace} :: ${key}\n${r.error?.message ?? out.trim()}`);
    return false;
  }
  console.log(`✓ ${namespace} :: ${key}`);
  if (verbose) console.log(out.trim());
  return true;
}

let ok = 0;
let failed = 0;
const track = (res) => {
  if (res) ok++;
  else failed++;
  // Fail fast: if nothing has succeeded after 3 attempts the problem is environmental, not per-entry.
  if (!res && ok === 0 && failed >= 3) {
    console.error('\nStopping: the first 3 entries all failed — fix the error above and re-run (safe to repeat).');
    process.exit(1);
  }
};

for (const file of targets) {
  const name = basename(file, '.md');
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  if (name === 'decisions') {
    const entries = text.split(/\n(?=\*\*D-\d{3})/).filter((e) => /^\*\*D-\d{3}/.test(e));
    for (const e of entries) track(store('decisions', e.match(/^\*\*(D-\d{3})/)[1], e.trim()));
    continue;
  }

  const sections = text.split(/\n(?=## )/);
  const intro = sections.shift() ?? '';
  const title = (intro.match(/^# (.+)$/m) ?? [])[1] ?? name;
  if (intro.trim()) track(store('nexlegtiq-spec', `${name}#intro`, intro.trim()));
  for (const s of sections) {
    const heading = (s.match(/^## (.+)$/m) ?? [])[1] ?? 'section';
    track(store('nexlegtiq-spec', `${name}#${slug(heading)}`, `[${title}] (docs/context/${name}.md)\n${s.trim()}`));
  }
}

console.log(`\nDone: ${ok} stored, ${failed} failed${dryRun ? ' (dry run)' : ''}.`);
if (!dryRun && ok > 0) {
  console.log(`Verify:      node "${rufloBin}" memory list --namespace decisions`);
  console.log(`Build index: node "${rufloBin}" memory search -q "tenant isolation" --build-hnsw`);
}
process.exit(failed ? 1 : 0);
