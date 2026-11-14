import { existsSync } from 'node:fs';

/** The worker image has Debian's chromium, GitHub's runners Google Chrome; a machine with neither skips (CI fails). */
export const TEST_CHROMIUM =
  process.env.PDF_CHROMIUM_PATH ??
  [
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((path) => existsSync(path));
export const canPrint = Boolean(TEST_CHROMIUM || process.env.CI);
