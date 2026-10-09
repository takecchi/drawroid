// @vitest-environment jsdom
// 塗ったマスクを口出しとして送る関数が、塗った画像と PNG を本文に載せ、断られた理由をそのまま投げることを見る試験。
// fetch は差し替え、hono/client が組む要求をそのまま受ける
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isApiError } from './api-error.js';
import { addMask } from './mutations.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const requestOf = (call: Parameters<typeof fetch>) => {
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return { url, method: init?.method ?? 'GET', body: init?.body };
};

const accepted = {
  mask: {
    kind: 'mask',
    interventionId: '0001',
    receivedAt: '2026-10-09T00:00:00.000Z',
    image: { iteration: 2, index: 1 },
  },
};

describe('addMask', () => {
  it('sends the painted image and the mask PNG as an intervention on the job', async () => {
    fetchMock.mockResolvedValue(json(202, accepted));

    const added = await addMask('20261009-000000-abcd', { iteration: 2, index: 1 }, 'iVBORw0KGgo=');

    expect(added).toEqual(accepted);
    const post = fetchMock.mock.calls.map(requestOf).find((r) => r.method === 'POST');
    expect(post?.url).toContain('/api/jobs/auto/20261009-000000-abcd/interventions');
    expect(JSON.parse(String(post?.body))).toEqual({
      kind: 'mask',
      image: { iteration: 2, index: 1 },
      mask: { data: 'iVBORw0KGgo=' },
    });
  });

  it('throws the reason the API gave when the job has already stopped', async () => {
    fetchMock.mockResolvedValue(
      json(409, { error: { kind: 'conflict', message: 'ジョブはもう止まっている' } }),
    );

    const error: unknown = await addMask('j', { iteration: 1, index: 0 }, 'iVBORw0KGgo=').catch(
      (e: unknown) => e,
    );

    expect(isApiError(error)).toBe(true);
    expect((error as Error).message).toBe('ジョブはもう止まっている');
  });
});
