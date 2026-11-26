#!/usr/bin/env node
// Bundle budgets of the web apps (MVP-117, D-235), gzip bytes of a built `dist/`: what the first page load fetches
// (index.html's script, module preloads and stylesheets), the largest chunk loaded later (a route, the PDF viewer) and
// the largest web worker (`.mjs`, the PDF.js worker). Apps not built (CI builds only affected ones) are skipped.
// Run after a build: `node scripts/check-bundle-budget.mjs`. The budgets sit a little above the baseline in
// docs/perf/baseline.md: raise one only with a reason in that file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const BUDGETS = {
  'office-app': { initial: 700 * KB, chunk: 150 * KB, worker: 390 * KB },
  'client-portal': { initial: 410 * KB, chunk: 60 * KB, worker: 0 },
  'admin-panel': { initial: 415 * KB, chunk: 100 * KB, worker: 0 },
};

const gzipped = (file) => gzipSync(readFileSync(file)).length;

/** The gzip sizes of one built app: the initial load, its largest later chunk and its largest worker. */
function measure(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const initialFiles = new Set(
    [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]),
  );
  const assets = readdirSync(join(dist, 'assets')).filter((f) => /\.(m?js|css)$/.test(f));
  let initial = 0;
  const largest = { chunk: { file: '-', size: 0 }, worker: { file: '-', size: 0 } };
  for (const file of assets) {
    const size = gzipped(join(dist, 'assets', file));
    const kind = file.endsWith('.mjs') ? 'worker' : 'chunk';
    if (initialFiles.has(`assets/${file}`)) initial += size;
    else if (size > largest[kind].size) largest[kind] = { file, size };
  }
  return { initial, ...largest };
}

function main() {
  const kb = (bytes) => `${(bytes / KB).toFixed(1)} kB`;
  let failed = false;
  for (const [app, budget] of Object.entries(BUDGETS)) {
    const dist = join('apps', app, 'dist');
    if (!existsSync(join(dist, 'index.html'))) {
      console.info(`${app}: not built, skipped`);
      continue;
    }
    const sizes = measure(dist);
    const over = [
      sizes.initial > budget.initial && 'initial',
      sizes.chunk.size > budget.chunk && 'chunk',
      sizes.worker.size > budget.worker && 'worker',
    ].filter(Boolean);
    failed ||= over.length > 0;
    console[over.length ? 'error' : 'info'](
      `${app}: initial ${kb(sizes.initial)} (budget ${kb(budget.initial)}), ` +
        `largest chunk ${sizes.chunk.file} ${kb(sizes.chunk.size)} (budget ${kb(budget.chunk)}), ` +
        `largest worker ${sizes.worker.file} ${kb(sizes.worker.size)} (budget ${kb(budget.worker)})` +
        (over.length ? ` — OVER BUDGET: ${over.join(', ')}` : ''),
    );
  }
  if (failed) process.exit(1);
}

main();
