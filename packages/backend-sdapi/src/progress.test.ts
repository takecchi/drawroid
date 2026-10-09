import { BackendError } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { SdapiClient } from './client.js';
import { readProgress } from './progress.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function running(overrides: Record<string, unknown> = {}) {
  return {
    progress: 0.25,
    eta_relative: 12.5,
    state: { job_count: 1, job_no: 0, sampling_step: 7, sampling_steps: 28, job: 'x' },
    current_image: null,
    textinfo: null,
    ...overrides,
  };
}

// 呼ばれた URL を残して、決めた応答を返す fetch
function clientReturning(body: unknown) {
  const urls: URL[] = [];
  const fetchStub = ((url: URL) => {
    urls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  const client = new SdapiClient({
    product: 'Forge',
    baseUrl: 'http://127.0.0.1:7860',
    timeoutMs: 5000,
    fetch: fetchStub,
  });
  return { client, urls };
}

const signal = () => new AbortController().signal;

describe('readProgress', () => {
  it('reads the fraction, the steps and the remaining time from a running response', async () => {
    const { client } = clientReturning(running());
    expect(await readProgress(client, signal())).toEqual({
      fraction: 0.25,
      step: 7,
      steps: 28,
      etaSeconds: 12.5,
    });
  });

  it('returns undefined when the backend has no job running', async () => {
    const { client } = clientReturning(running({ progress: 0, state: { job_count: 0 } }));
    expect(await readProgress(client, signal())).toBeUndefined();
  });

  it('clamps the fraction into 0 to 1', async () => {
    expect(
      (await readProgress(clientReturning(running({ progress: 1.7 })).client, signal()))?.fraction,
    ).toBe(1);
    expect(
      (await readProgress(clientReturning(running({ progress: -0.2 })).client, signal()))?.fraction,
    ).toBe(0);
  });

  it('reports a missing or non-positive ETA as null', async () => {
    for (const eta of [0, -3, undefined, null]) {
      const { client } = clientReturning(running({ eta_relative: eta }));
      expect((await readProgress(client, signal()))?.etaSeconds).toBeNull();
    }
  });

  it('reports missing steps as null', async () => {
    const { client } = clientReturning(running({ state: { job_count: 1 } }));
    const progress = await readProgress(client, signal());
    expect(progress).toMatchObject({ step: null, steps: null });
  });

  it('asks the backend to skip the current image unless a preview is requested', async () => {
    const withoutOptions = clientReturning(running({ current_image: base64(PNG) }));
    const progress = await readProgress(withoutOptions.client, signal());
    expect(withoutOptions.urls[0]?.search).toBe('?skip_current_image=true');
    expect(progress).not.toHaveProperty('preview');

    const explicitFalse = clientReturning(running());
    await readProgress(explicitFalse.client, signal(), { includePreview: false });
    expect(explicitFalse.urls[0]?.search).toBe('?skip_current_image=true');
  });

  it('attaches the preview, with its type read from the leading bytes, when requested', async () => {
    for (const [bytes, mediaType] of [
      [PNG, 'image/png'],
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp'],
    ] as const) {
      const { client, urls } = clientReturning(running({ current_image: base64(bytes) }));
      const progress = await readProgress(client, signal(), { includePreview: true });
      expect(urls[0]?.search).toBe('?skip_current_image=false');
      expect(progress?.preview).toEqual({ data: bytes, mediaType });
    }
  });

  it('leaves the preview out when the image is absent or not a known format', async () => {
    const none = clientReturning(running());
    expect(await readProgress(none.client, signal(), { includePreview: true })).not.toHaveProperty(
      'preview',
    );
    const unknown = clientReturning(
      running({ current_image: base64(new Uint8Array([1, 2, 3, 4])) }),
    );
    expect(
      await readProgress(unknown.client, signal(), { includePreview: true }),
    ).not.toHaveProperty('preview');
  });

  it('classifies a backend that cannot be reached as unreachable', async () => {
    const client = new SdapiClient({
      product: 'Forge',
      baseUrl: 'http://127.0.0.1:7860',
      timeoutMs: 5000,
      fetch: (() =>
        Promise.reject(
          new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
        )) as unknown as typeof fetch,
    });
    const error: unknown = await readProgress(client, signal()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).kind).toBe('unreachable');
  });
});
