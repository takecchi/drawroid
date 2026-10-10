import type { Config } from '@react-router/dev/config';

// SSR にしない: Web UI は drawroid のプロセスが静的に配るだけで、画面のための実行系をもう一つ持たないため
export default {
  ssr: false,
  // v8 の future flag を true にして opt-in しない: 振る舞いが変わるため。
  // 未指定のままにしないのは、未指定だと起動・ビルドのたびに警告が出るため（false は未指定の既定と同じ振る舞い）
  future: {
    v8_middleware: false,
    v8_splitRouteModules: false,
    v8_viteEnvironmentApi: false,
    v8_passThroughRequests: false,
    v8_trailingSlashAwareDataRequests: false,
  },
} satisfies Config;
