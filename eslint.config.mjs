import nx from '@nx/eslint-plugin';

import { depConstraints } from './packages/shared-config/eslint/module-boundaries.mjs';

// Baseline config. The full rule set (import order, no-literal-string, complexity…) arrives with MVP-29.
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/test-output', '**/vite.config.*.timestamp*', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\.base)?\.config\.[cm]?[jt]s$'],
          depConstraints,
        },
      ],
    },
  },
];
