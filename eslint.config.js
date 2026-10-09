import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/bundle/',
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
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  // core にファイル・HTTP・LLM の実装を持ち込ませない: core が外を知った瞬間に、バックエンドや provider を差し替えるときループの中心を書き換えることになるため（docs/architecture.md「パッケージ構成」）
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/*',
                'path',
                'hono',
                'hono/*',
                'ai',
                '@ai-sdk/*',
                '@drawroid/*',
              ],
              message:
                'packages/core は外界（ファイル・HTTP・LLM・ほかのパッケージ）を import しない。ポートを定義し、実装はアダプタに置く。',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
