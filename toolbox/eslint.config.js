import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // A config object carrying `ignores` alongside `rules` only ignores those paths for its own
  // rules. Everything built into dist/ was therefore linted as source, which is where all 158
  // of the previous errors came from. Global ignores have to stand alone.
  {
    ignores: ['dist/**', 'storybook-static/**', 'coverage/**', 'node_modules/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // A leading underscore marks an argument kept for its position rather than its value.
      // Express detects an error handler by its arity, so `_next` cannot simply be dropped.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // Tests and stories run under vitest globals and may reach for `any` freely.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.stories.tsx', 'src/testing/**'],
    languageOptions: { globals: globals.vitest },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // The Tailwind preset is CommonJS on purpose: Tailwind requires() it.
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
);
