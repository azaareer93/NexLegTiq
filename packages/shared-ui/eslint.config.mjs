import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';
import { noLiteralString } from '../shared-config/eslint/no-literal-string.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  ...noLiteralString,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    ignores: ['**/out-tsc'],
  },
];
