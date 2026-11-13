import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Prints an HTML page to PDF with headless Chromium's own `--print-to-pdf` (D-171): no driver library. The page is our
 * template with every value escaped, no script and no external resource (`--blink-settings=scriptEnabled=false` stops
 * the print itself); the tool gets a private profile in a temporary folder (removed afterwards) and none of the
 * server's secrets in its environment. `--no-sandbox` because the
 * worker container drops every capability Chromium's sandbox needs.
 */
export async function printPdf(
  chromium: string,
  html: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const folder = await mkdtemp(join(tmpdir(), 'nlq-pdf-'));
  try {
    const page = join(folder, 'invoice.html');
    const out = join(folder, 'invoice.pdf');
    await writeFile(page, html, 'utf8');
    const { PATH, SystemRoot } = process.env;
    await execute(
      chromium,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-pdf-header-footer',
        `--user-data-dir=${join(folder, 'profile')}`,
        `--print-to-pdf=${out}`,
        pathToFileURL(page).href,
      ],
      {
        signal,
        // SystemRoot only exists on Windows (local development with Chrome); Chromium needs it there.
        env: { PATH: PATH ?? '', HOME: folder, ...(SystemRoot ? { SystemRoot } : {}) },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return await readFile(out);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
