import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/*.db.test.{ts,tsx}'],
    testTimeout: 15000,
    hookTimeout: 15000,
    fakeTimers: {
      // Avoid mocking queueMicrotask (Vitest 3+ default) — prevents memory growth in CI.
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    },
    coverage: {
      provider: 'v8',
      // 'blob' is required for cross-shard merging via `vitest --mergeReports`.
      // 'json-summary' feeds the coverage-comment workflow.
      // 'text' keeps local runs readable.
      reporter: ['text', 'json-summary', 'blob'],
      cleanOnRerun: true,
      exclude: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/node_modules/**',
        '**/.next/**',
      ],
    },
    projects: [
      {
        // Default jsdom project — unchanged behavior for CI without a database.
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/.next/**', '**/*.db.test.{ts,tsx}'],
        },
      },
      {
        // Database-backed concurrency suite. Only registered when TEST_DATABASE_URL
        // is set so CI without a database still passes.
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: ['src/**/*.db.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/.next/**'],
          // Concurrency races need real timers and a longer budget.
          fakeTimers: {
            toFake: [],
          },
          testTimeout: 60000,
          hookTimeout: 60000,
          // Run DB suites serially to avoid cross-test interference on shared tables.
          fileParallelism: false,
          sequence: {
            concurrent: false,
          },
        },
      },
    ].filter((project) => project.test.name !== 'db' || hasTestDatabase),
  },
});