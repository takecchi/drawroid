import type { Config } from '@react-router/dev/config';

// SSR にしない: Web UI は drawroid のプロセスが静的に配るだけで、画面のための実行系をもう一つ持たないため
export default {
  ssr: false,
} satisfies Config;
