import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// `@/` を `packages/ui` の外で使わせない: 画面から `@/components/ui/button` のように書いても通ってしまい、`@drawroid/ui` の公開の口（`exports`）を素通りして中身へ手を入れる経路になるため。
const UI_ALIAS_BAN = {
  group: ['@/*'],
  message:
    '@/ は packages/ui の中だけの別名である。画面・ほかのパッケージからは @drawroid/ui（見た目の部品）か ' +
    '@drawroid/ui/shadcn（shadcn の素の部品）から import すること。',
};

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
      '**/storybook-static/',
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
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    ignores: ['packages/ui/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [UI_ALIAS_BAN] }],
    },
  },
  prettier,
);
