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
    // これだけ opt-in する: false だと dev の依存の事前束ねが画面を開くまで始まらず、初めて開いたときに vite が束ね直して
    // 再読み込みを送るが、ページの HMR の接続より先に送られて届かず、古い束への 504 で「読み込んでいます…」のまま止まる。
    // 変わるのは dev の optimizeDeps.entries だけ。build の成果物は index.html に載る flag の値のほかは同じ
    unstable_optimizeDeps: true,
  },
} satisfies Config;
