import baseConfig from '../../eslint.config.mjs';
import { backendRules } from '../../packages/shared-config/eslint/backend-rules.mjs';

export default [
  ...baseConfig,
  ...backendRules,
  // CLI scripts (seeds) report progress on the terminal; the app itself logs through PinoLogger.
  { files: ['prisma/**/*.ts'], rules: { 'no-console': 'off' } },
];
