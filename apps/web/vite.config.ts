import { stripVTControlCharacters } from 'node:util';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { createLogger, defineConfig } from 'vite';

const apiUrl = process.env.DRAWROID_API_URL ?? 'http://127.0.0.1:7878';

// reportCompressedSize: false や logLevel: 'warn' にしない: 前者は gzip の列だけ消えて一覧は残り、
// 後者は警告以外の進捗も消える。成果物の一覧行（フォントだけで約 2200 行）だけを info から落とし、
// warn / error と「N assets cleaned」などの見出し行は素通しにする。
// 一覧行は 2 種類ある: vite のレポータの「パス  サイズ」と、React Router が server build から掃除した資産を並べる「パスだけ」の行
const assetListLine = /^build\/(client|server)\/\S+(\s+[\d.]+ \S+.*)?$/;

function createQuietBuildLogger() {
  const logger = createLogger();
  const info = logger.info.bind(logger);
  logger.info = (message, options) => {
    const kept = message
      .split('\n')
      .filter((line) => !assetListLine.test(stripVTControlCharacters(line)));
    if (kept.length === 0) return;
    info(kept.join('\n'), options);
  };
  return logger;
}

export default defineConfig({
  customLogger: createQuietBuildLogger(),
  // tailwindcss() は reactRouter() より前に置く: CSS の変換が先に要るため
  plugins: [tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      '/api': { target: apiUrl },
    },
  },
});
