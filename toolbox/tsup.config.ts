import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'ui/index': 'src/ui/index.ts',
    'hooks/index': 'src/hooks/index.ts',
    'utils/index': 'src/utils/index.ts',
    'forms/index': 'src/forms/index.tsx',
    'data/index': 'src/data/index.ts',
    'charts/index': 'src/charts/index.ts',
    'offline/index': 'src/offline/index.ts',
    'icons/index': 'src/icons/index.tsx',
    'testing/index': 'src/testing/index.tsx',
    'node/index': 'src/node/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: true,
  external: ['react', 'react-dom'],
  publicDir: false,
  onSuccess: 'cp src/tokens/tokens.css dist/tokens.css',
});
