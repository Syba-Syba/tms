import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__clicks__/setup.ts'],
    // Starts the API when nothing is listening, so `npm test` needs no second terminal.
    globalSetup: ['./src/__clicks__/global-setup.ts'],
    css: false,
    // The app under test talks to the suite's own API, never the development one on 3001.
    env: { VITE_API_URL: 'http://localhost:3101' },
    // The clicks hit one live API, so screens run one at a time in a stable order.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
