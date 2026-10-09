import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BackendError } from '@drawroid/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SdapiClient } from './client.js';

/** いま誰も待ち受けていない URL */
async function unusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('SdapiClient', () => {
  it('names the product in the advice when the backend cannot be reached', async () => {
    const client = new SdapiClient({
      product: 'A1111',
      baseUrl: await unusedUrl(),
      timeoutMs: 5000,
    });

    const error: unknown = await client.getJson('/sdapi/v1/cmd-flags', z.unknown()).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).kind).toBe('unreachable');
    expect((error as BackendError).message).toContain('A1111 が起動しているか');
  });

  it('names the product when the URL cannot be read', () => {
    expect(() => new SdapiClient({ product: 'A1111', baseUrl: 'not a url', timeoutMs: 1 })).toThrow(
      'A1111 の URL として読めない',
    );
  });

  it.each([
    [401, 'unauthorized', 'A1111 の --api-auth'],
    [404, 'not_found', 'A1111 を --api 付きで起動しているか'],
    [500, 'failed', 'A1111 が失敗を返した'],
  ] as const)(
    'names the product when the backend answers HTTP %i',
    async (status, kind, advice) => {
      // その状態だけを返す偽のバックエンド
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: '理由' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const client = new SdapiClient({
          product: 'A1111',
          baseUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 5000,
        });
        const error: unknown = await client.getJson('/sdapi/v1/cmd-flags', z.unknown()).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(BackendError);
        expect((error as BackendError).kind).toBe(kind);
        // どちらのバックエンドの失敗かが文から分かる（Forge と書かない）
        expect((error as BackendError).message).toContain(advice);
        expect((error as BackendError).message).not.toContain('Forge');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  // 失敗の文から、どちらのバックエンドの失敗かが分かる（ジョブの止まった理由やログには、画面の補いが付かないため）
  describe.each(['Forge', 'A1111'])('naming %s in every failure', (product) => {
    const other = product === 'Forge' ? 'A1111' : 'Forge';
    async function failureWith(fakeFetch: typeof fetch, timeoutMs = 5000) {
      const client = new SdapiClient({
        product,
        baseUrl: 'http://127.0.0.1:7860',
        timeoutMs,
        fetch: fakeFetch,
      });
      const error: unknown = await client
        .getJson('/sdapi/v1/cmd-flags', z.object({ ok: z.boolean() }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(BackendError);
      return error as BackendError;
    }

    it.each([
      [
        'times out',
        'timeout',
        // 止められるまで返らない
        ((_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          )) as typeof fetch,
        20,
      ],
      [
        'answers a body that is not JSON',
        'bad_response',
        (async () => new Response('<html>')) as typeof fetch,
        5000,
      ],
      [
        'answers JSON of another shape',
        'bad_response',
        (async () => new Response('{"ok":"yes"}')) as typeof fetch,
        5000,
      ],
      [
        'cannot be reached for a reason without a known code',
        'unreachable',
        (async () => {
          throw new TypeError('fetch failed', { cause: new Error('何かが起きた') });
        }) as typeof fetch,
        5000,
      ],
    ] as const)('when it %s', async (_case, kind, fakeFetch, timeoutMs) => {
      const error = await failureWith(fakeFetch, timeoutMs);

      expect(error.kind).toBe(kind);
      expect(error.message).toContain(product);
      expect(error.message).not.toContain(other);
    });
  });
});
