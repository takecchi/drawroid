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
});
