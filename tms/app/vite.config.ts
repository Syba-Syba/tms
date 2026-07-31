import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// npm workspaces hoists one copy of each of these to the root, which is the real fix. This
// stays as a guard for anyone who installs this package on its own, where the toolbox would
// bring its own node_modules and a second React Query would silently miss the provider.
const SINGLETONS = ['react', 'react-dom', 'react-hook-form', '@tanstack/react-query', 'zod'];

export default defineConfig({
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
        ],
      },
      workbox: {
        // Documents are large and private, so only the shell is precached.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
});
