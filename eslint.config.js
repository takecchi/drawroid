import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/*.d.ts',
      '**/build/',
      '**/.react-router/',
      '**/coverage/',
      '.pnpm-store/',
      '.idea/',
      '.vscode/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
  prettier,
);
