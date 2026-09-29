import { ESLint } from 'eslint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RULE = '@nx/enforce-module-boundaries';

let eslint: ESLint;

/** Lints `code` as if it lived at `filePath` (relative to the workspace root) and returns boundary errors. */
async function boundaryErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(workspaceRoot, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe('module boundaries', () => {
  // Loading the flat config and the Nx project graph is slow on a cold start.
  beforeAll(async () => {
    eslint = new ESLint({ cwd: workspaceRoot });
    await eslint.calculateConfigForFile(resolve(workspaceRoot, 'packages/shared-types/src/index.ts'));
  }, 60_000);

  it.each([
    ['shared-types importing shared-i18n', 'packages/shared-types/src/fixture.ts', '@nexlegtiq/shared-i18n'],
    ['shared-utils importing shared-contracts', 'packages/shared-utils/src/fixture.ts', '@nexlegtiq/shared-contracts'],
    ['shared-ui importing shared-api-client', 'packages/shared-ui/src/fixture.ts', '@nexlegtiq/shared-api-client'],
    ['backend-api importing shared-ui', 'apps/backend-api/src/fixture.ts', '@nexlegtiq/shared-ui'],
    ['backend-api importing shared-api-client', 'apps/backend-api/src/fixture.ts', '@nexlegtiq/shared-api-client'],
  ])('should fail lint for %s', async (_case, filePath, target) => {
    const errors = await boundaryErrors(filePath, `import * as forbidden from '${target}';\nexport { forbidden };\n`);
    // Assert the tag constraint fired (not e.g. the circular-dependency check of the same rule).
    expect(errors).toEqual([expect.stringMatching(/tagged with/)]);
  });

  it.each([
    ['shared-utils importing shared-types', 'packages/shared-utils/src/fixture.ts', '@nexlegtiq/shared-types'],
    ['shared-contracts importing shared-utils', 'packages/shared-contracts/src/fixture.ts', '@nexlegtiq/shared-utils'],
    ['shared-ui importing shared-i18n', 'packages/shared-ui/src/fixture.ts', '@nexlegtiq/shared-i18n'],
    ['backend-api importing shared-contracts', 'apps/backend-api/src/fixture.ts', '@nexlegtiq/shared-contracts'],
    ['office-app importing shared-ui', 'apps/office-app/src/fixture.ts', '@nexlegtiq/shared-ui'],
  ])('should allow %s', async (_case, filePath, target) => {
    const errors = await boundaryErrors(filePath, `import * as allowed from '${target}';\nexport { allowed };\n`);
    expect(errors).toEqual([]);
  });
});
