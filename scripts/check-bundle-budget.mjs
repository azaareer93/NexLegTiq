#!/usr/bin/env node
// Bundle budgets of the web apps (MVP-117, D-235), gzip bytes of a built `dist/`: what the first page load fetches
// (index.html's script, module preloads and stylesheets) and the largest chunk loaded later (a route, the PDF viewer).
// Apps not built (CI builds only affected ones) are skipped. Run after a build: `node scripts/check-bundle-budget.mjs`.
// The budgets sit a little above the baseline in docs/perf/baseline.md: raise one only with a reason in that file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const BUDGETS = {
  'office-app': { initial: 700 * KB, chunk: 150 * KB },
  'client-portal': { initial: 410 * KB, chunk: 60 * KB },
  'admin-panel': { initial: 415 * KB, chunk: 100 * KB },
};

const gzipped = (file) => gzipSync(readFileSync(file)).length;

/** The gzip sizes of one built app: the initial load and its largest other asset. */
function measure(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const initialFiles = new Set(
    [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]),
  );
  const assets = readdirSync(join(dist, 'assets')).filter((f) => /\.(js|css)$/.test(f));
  let initial = 0;
  let largest = { file: '', size: 0 };
  for (const file of assets) {
    const size = gzipped(join(dist, 'assets', file));
    if (initialFiles.has(`assets/${file}`)) initial += size;
    else if (size > largest.size) largest = { file, size };
  }
  return { initial, largest };
}

function main() {
  let failed = false;
  for (const [app, budget] of Object.entries(BUDGETS)) {
    const dist = join('apps', app, 'dist');
    if (!existsSync(join(dist, 'index.html'))) {
      console.info(`${app}: not built, skipped`);
      continue;
    }
    const { initial, largest } = measure(dist);
    const kb = (bytes) => `${(bytes / KB).toFixed(1)} kB`;
    const over = initial > budget.initial || largest.size > budget.chunk;
    failed ||= over;
    console[over ? 'error' : 'info'](
      `${app}: initial ${kb(initial)} (budget ${kb(budget.initial)}), largest chunk ${largest.file} ` +
        `${kb(largest.size)} (budget ${kb(budget.chunk)})${over ? ' — OVER BUDGET' : ''}`,
    );
  }
  if (failed) process.exit(1);
}

main();
