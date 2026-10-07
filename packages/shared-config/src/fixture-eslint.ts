import { ESLint } from 'eslint';

/**
 * Lint specs check code at made-up paths (`src/x.tsx`, `src/fixture.ts`) that no tsconfig includes. The type-aware rules
 * need a TypeScript program for every file, so these names are linted in TypeScript's default project — in tests only.
 */
const FIXTURES = ['x.ts', 'x.tsx', 'x.test.tsx', 'x.stories.tsx', 'fixture.ts'].flatMap((name) => [
  `apps/*/src/${name}`,
  `packages/*/src/${name}`,
]);

export const fixtureLinter = (cwd: string): ESLint =>
  new ESLint({
    cwd,
    overrideConfig: {
      languageOptions: { parserOptions: { projectService: { allowDefaultProject: FIXTURES } } },
    },
  });
