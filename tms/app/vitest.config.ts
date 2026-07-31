import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__clicks__/setup.ts'],
    css: false,
    // The clicks hit the live dev API, so screens run one at a time in a stable order.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
