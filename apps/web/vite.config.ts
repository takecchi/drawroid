import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

const apiUrl = process.env.DRAWROID_API_URL ?? 'http://127.0.0.1:7878';

export default defineConfig({
  plugins: [reactRouter()],
  server: {
    proxy: {
      '/api': { target: apiUrl },
    },
  },
});
