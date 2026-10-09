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
});
