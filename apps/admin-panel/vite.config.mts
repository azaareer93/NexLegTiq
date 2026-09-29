/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/admin-panel',
  server: {
    port: 4201,
    strictPort: true,
    host: 'localhost',
  },
  preview: {
    port: 4201,
    strictPort: true,
    host: 'localhost',
  },
  plugins: [react()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
  },
  test: {
    name: 'admin-panel',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{spec,test}.{ts,tsx}', 'src/**/index.ts', 'src/main.tsx', 'src/app/router.ts'],
      // D-071 quality gate (enforced when run with --coverage, as CI does)
      thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
    }
  },
}));
