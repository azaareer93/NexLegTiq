import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import nx from '@nx/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

import { depConstraints } from './module-boundaries.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Physical CSS properties in inline styles; the logical ones (`marginInlineStart`, `insetInlineEnd`…) follow the direction. */
const PHYSICAL_STYLE =
  '/^(margin|padding|border)(Left|Right)|^(left|right)$|^border(Top|Bottom)(Left|Right)Radius$/';

const TESTS = [
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/test/**',
  '**/*.stories.tsx',
];

/**
 * The workspace ESLint rules (quality-testing.md#lint--format, MVP-29, D-094): the root `eslint.config.mjs` re-exports
 * this, and every project config spreads the root. Everything is an error — CI and `nx lint` allow no warnings.
 */
export const baseConfig = [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/test-output',
      '**/coverage',
      '**/storybook-static',
      '**/generated/**',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    plugins: { import: importPlugin },
    rules: {
      // Log through the injected PinoLogger (backend) / nothing in production UI code.
      'no-console': 'error',
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', ['internal', 'parent', 'sibling', 'index']],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          // Project ESLint configs import the root config and the shared rule files by path.
          allow: [
            String.raw`^.*/eslint(\.base)?\.config\.[cm]?[jt]s$`,
            String.raw`^.*/shared-config/eslint/[\w-]+\.mjs$`,
          ],
          depConstraints,
        },
      ],
    },
  },
  {
    // Type-aware rules: each file is checked with the tsconfig that includes it (TypeScript's project service).
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: workspaceRoot } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      // `_`-prefixed names and the rest siblings of a destructuring (`{ secret: _s, ...rest }`) are deliberately unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `JSXAttribute[name.name='style'] Property > Identifier.key[name=${PHYSICAL_STYLE}]`,
          message:
            'Use the logical property (marginInlineStart, paddingInlineEnd, insetInlineStart…): RTL layouts mirror (frontend.md).',
        },
      ],
    },
  },
  {
    // Tests read untyped HTTP bodies and mocks (`res.body` is `any`) and are long by nature; floating promises still count.
    files: TESTS,
    rules: {
      'max-lines': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // Command-line scripts report on the terminal.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Plain JavaScript (configs, scripts) has no tsconfig: no type-aware rules there.
    files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
];
