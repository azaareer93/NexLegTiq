#!/usr/bin/env node
/**
 * Sorts the shared translation files every ticket adds keys to (D-147): validation and errors at every level, enums by
 * enum name (each enum keeps the order of its values). Sorted keys put a new key next to its neighbours instead of at
 * the end, so two open PRs rarely touch the same lines. Run by the pre-commit hook on staged locale files; the shared-i18n
 * test fails when a file is out of order. Usage: node scripts/sort-locales.mjs <file.json>…
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = (value, deep) =>
  Object.fromEntries(
    Object.keys(value)
      .sort(byCodePoint)
      .map((key) => {
        const child = value[key];
        return [key, deep && child && typeof child === 'object' ? sortKeys(child, deep) : child];
      }),
  );
const DEPTH = { 'validation.json': true, 'errors.json': true, 'enums.json': false };

for (const file of process.argv.slice(2)) {
  const deep = DEPTH[basename(file)];
  if (deep === undefined) continue;
  const text = readFileSync(file, 'utf8');
  const sorted = `${JSON.stringify(sortKeys(JSON.parse(text), deep), null, 2)}\n`;
  if (sorted !== text) writeFileSync(file, sorted);
}
