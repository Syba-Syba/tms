import { defineConfig } from 'vitest/config';

/**
 * Unit tests only: no API, no click setup. Safe to run while the self-hosted server is up,
 * which the click tests refuse to do because they would write to its real data.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    exclude: ['src/__clicks__/**', 'node_modules/**'],
  },
});
