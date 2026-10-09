import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // `@/` は packages/ui の中だけの別名（shadcn の部品が互いを import する形）
    alias: { '@': fileURLToPath(new URL('./packages/ui/src', import.meta.url)) },
  },
  test: {
    include: [
      'scripts/**/*.test.ts',
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/app/**/*.test.{ts,tsx}',
    ],
  },
});
