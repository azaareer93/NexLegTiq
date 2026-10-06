import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/shared-config',
  test: {
    name: 'shared-config',
    watch: false,
    globals: true,
    environment: 'node',
    // Boundary tests lint fixtures with real ESLint + the Nx project graph; slow on a cold CI runner.
    testTimeout: 30_000,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{spec,test}.{ts,tsx}', 'src/**/index.ts'],
      // D-071 quality gate (enforced when run with --coverage, as CI does)
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
}));
