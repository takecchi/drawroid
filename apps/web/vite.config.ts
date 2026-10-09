import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const apiUrl = process.env.DRAWROID_API_URL ?? 'http://127.0.0.1:7878';

export default defineConfig({
  // tailwindcss() は reactRouter() より前に置く: CSS の変換が先に要るため
  plugins: [tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      '/api': { target: apiUrl },
    },
  },
});
