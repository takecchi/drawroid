import { describe, expect, it } from 'vitest';

import { listeningLine } from './dev-mode.js';

const address = { address: '127.0.0.1', port: 7878 };

describe('listeningLine', () => {
  it('names the URL to open when drawroid serves the screen itself', () => {
    expect(listeningLine(address, {})).toBe('drawroid: http://127.0.0.1:7878/');
  });

  // pnpm dev では端末に URL が2つ出る。drawroid の URL を開くと画面が無いので、開く先を Vite の URL に寄せる
  it('says that this URL is the API and names the Vite URL to open during development', () => {
    expect(listeningLine(address, { DRAWROID_DEV_WEB_URL: 'http://localhost:5173/' })).toBe(
      'drawroid: API http://127.0.0.1:7878/（画面は http://localhost:5173/ を開く）',
    );
  });
});
