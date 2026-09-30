const { readFileSync } = require('fs');

// Integration tests against a real PostgreSQL (DATABASE_URL from .env locally, from the workflow in CI).
// Run after migrations: `pnpm nx run backend-api:prisma-deploy && pnpm nx run backend-api:integration`.
const swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));
swcJestConfig.swcrc = false;

module.exports = {
  displayName: 'backend-api-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.int.spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
};
