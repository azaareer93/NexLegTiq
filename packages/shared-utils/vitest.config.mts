import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/shared-utils',
  test: {
    name: 'shared-utils',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{spec,test}.{ts,tsx}', 'src/**/index.ts'],
      // packages.md: pure utils are 100% covered (enforced when run with --coverage, as CI does)
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
}));
