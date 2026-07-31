import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // PGlite boots a WebAssembly Postgres per file, which is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
