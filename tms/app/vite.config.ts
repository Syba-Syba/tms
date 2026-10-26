import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// npm workspaces hoists one copy of each of these to the root, which is the real fix. This
// stays as a guard for anyone who installs this package on its own, where the toolbox would
// bring its own node_modules and a second React Query would silently miss the provider.
const SINGLETONS = ['react', 'react-dom', 'react-hook-form', '@tanstack/react-query', 'zod'];

export default defineConfig(({ command, mode }) => {
  // src/api/client.ts falls back to http://localhost:3001 when VITE_API_URL is unset, which is
  // right for `npm run dev` and wrong for anything built: the value is baked in at build time,
  // so the bundle shipped to a phone or a server pointed at the developer's own machine and
  // every call failed. A build now stops here instead.
  if (command === 'build' && !loadEnv(mode, process.cwd(), '').VITE_API_URL) {
    throw new Error(
      'VITE_API_URL is not set, and a build bakes it in permanently.\n' +
        '  Self-hosted (API serves the app): VITE_API_URL=/\n' +
        '  Separate API host or Android APK:  VITE_API_URL=https://api.example.co.za',
    );
  }

  return {
  resolve: { dedupe: SINGLETONS },
  optimizeDeps: { include: SINGLETONS },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Kruis Court Tenants',
        short_name: 'Kruis Court',
        start_url: '/',
        display: 'standalone',
        background_color: '#e9e6e0',
        theme_color: '#6d3557',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // The house sits inside the central 80%, so Android can crop it to any mask shape.
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Documents are large and private, so only the shell is precached.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  };
});
