// @vitest-environment jsdom
// バックエンドの設定の保存が、PUT の body に何を載せるかを見る試験。
// fetch は差し替え、送った body を読む
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveBackendSettings } from './mutations.js';

vi.mock('swr', () => ({
  default: vi.fn(),
  mutate: () => Promise.resolve(),
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 保存で送った PUT の body を JSON として読む */
async function sentBody(): Promise<unknown> {
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), 'http://localhost'), init);
  expect(request.method).toBe('PUT');
  return JSON.parse(await request.text());
}

const saved = {
  kind: 'forge',
  kindSource: 'config',
  url: 'http://gpu:7860',
  urlSource: 'config',
  startupArgs: { kind: false, url: false },
  auth: null,
  generateTimeoutMs: null,
};

describe('saving the backend settings', () => {
  it('sends only the kind in the body when the url is left out', async () => {
    fetchMock.mockResolvedValue(json(200, saved));
    await saveBackendSettings({ kind: 'forge' });
    expect(await sentBody()).toEqual({ kind: 'forge' });
  });

  it('sends the kind in the body when one is given', async () => {
    fetchMock.mockResolvedValue(json(200, saved));
    await saveBackendSettings({ url: 'http://gpu:7860', kind: 'forge' });
    expect(await sentBody()).toEqual({ url: 'http://gpu:7860', kind: 'forge' });
  });

  it('sends no kind in the body when it is left out', async () => {
    fetchMock.mockResolvedValue(json(200, saved));
    await saveBackendSettings({ url: 'http://gpu:7860' });
    expect(await sentBody()).toEqual({ url: 'http://gpu:7860' });
  });
});
