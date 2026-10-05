import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StorybookConfig } from '@storybook/react-vite';

/** Storybook for shared-ui (D-088): every story in Arabic (RTL) and English (LTR) via the toolbar, with the a11y addon. */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: [getAbsolutePath('@storybook/addon-a11y')],
  framework: {
    name: getAbsolutePath('@storybook/react-vite'),
    options: {},
  },
  // No usage data leaves the machine (D-077: no unreviewed traffic).
  core: { disableTelemetry: true },
};

// pnpm keeps packages out of the hoisted root: Storybook needs their real location.
function getAbsolutePath<T extends string>(value: T): T {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`))) as T;
}

export default config;
