import { describeImageBackendContract, STUB_PNG } from '@drawroid/core/testing';
import { BackendError, generationRequestSchema } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForgeBackend } from './forge-backend.js';
import {
  fixture,
  json,
  startMockForge,
  unusedUrl,
  type MockForge,
} from './test-support/mock-forge.js';

describeImageBackendContract('ForgeBackend against the mock Forge', {
  connected: async () => {
    const forge = await startMockForge();
    return { backend: new ForgeBackend({ baseUrl: forge.url }), close: () => forge.close() };
  },
  unreachable: async () => ({ backend: new ForgeBackend({ baseUrl: await unusedUrl() }) }),
});

describe('ForgeBackend', () => {
  let forge: MockForge;

  beforeEach(async () => {
    forge = await startMockForge();
  });

  afterEach(async () => {
    await forge.close();
  });

  it('asks Forge to interrupt the running generation', async () => {
    await new ForgeBackend({ baseUrl: forge.url }).interrupt();
    expect(forge.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /sdapi/v1/interrupt',
    ]);
  });

  it('passes the image contents through to the img2img request', async () => {
    const source = 'iterations/0001/images/0.png';
    await new ForgeBackend({ baseUrl: forge.url }).generate(
      generationRequestSchema.parse({
        prompt: 'a cat',
        steps: 4,
        cfgScale: 7,
        width: 64,
        height: 64,
        img2img: { image: source, denoisingStrength: 0.5 },
      }),
      new AbortController().signal,
      new Map([[source, { data: STUB_PNG, mediaType: 'image/png' }]]),
    );

    const sent = forge.requests.find((r) => r.path === '/sdapi/v1/img2img');
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
      init_images: [Buffer.from(STUB_PNG).toString('base64')],
    });
  });

  it('gives generation its own, longer time limit than other calls', async () => {
    forge.route('POST /sdapi/v1/txt2img', () => undefined);
    const backend = new ForgeBackend({
      baseUrl: forge.url,
      requestTimeoutMs: 5_000,
      generateTimeoutMs: 100,
    });
    await expect(
      backend.generate(
        {
          prompt: 'a',
          negativePrompt: '',
          loras: [],
          steps: 1,
          cfgScale: 1,
          width: 8,
          height: 8,
          batchSize: 1,
          controlnet: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  describe('progress', () => {
    const PROGRESS = 'GET /sdapi/v1/progress';
    const signal = () => new AbortController().signal;
    const progressRequests = () => forge.requests.filter((r) => r.path === '/sdapi/v1/progress');

    it('reads the fraction, the steps and the remaining time of a running generation', async () => {
      forge.route(PROGRESS, json(200, fixture('progress-running.json')));
      expect(await new ForgeBackend({ baseUrl: forge.url }).progress(signal())).toEqual({
        fraction: 0.4385714285714286,
        step: 12,
        steps: 28,
        etaSeconds: 5.73,
      });
    });

    it('returns undefined when nothing is running', async () => {
      expect(await new ForgeBackend({ baseUrl: forge.url }).progress(signal())).toBeUndefined();
    });

    it('asks to skip the current image, and attaches no preview, unless one is requested', async () => {
      forge.route(
        PROGRESS,
        json(200, {
          ...(fixture('progress-running.json') as object),
          current_image: Buffer.from(STUB_PNG).toString('base64'),
        }),
      );
      const b = new ForgeBackend({ baseUrl: forge.url });
      expect(await b.progress(signal())).not.toHaveProperty('preview');
      expect(await b.progress(signal(), { includePreview: false })).not.toHaveProperty('preview');
      expect(progressRequests().map((r) => r.search)).toEqual([
        '?skip_current_image=true',
        '?skip_current_image=true',
      ]);
    });

    it('attaches the preview as a PNG when one is requested', async () => {
      forge.route(
        PROGRESS,
        json(200, {
          ...(fixture('progress-running.json') as object),
          current_image: Buffer.from(STUB_PNG).toString('base64'),
        }),
      );
      const progress = await new ForgeBackend({ baseUrl: forge.url }).progress(signal(), {
        includePreview: true,
      });
      expect(progressRequests().map((r) => r.search)).toEqual(['?skip_current_image=false']);
      expect(progress?.preview).toEqual({ data: STUB_PNG, mediaType: 'image/png' });
    });

    it('classifies an unreachable backend as unreachable', async () => {
      const error: unknown = await new ForgeBackend({ baseUrl: await unusedUrl() })
        .progress(signal())
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(BackendError);
      expect((error as BackendError).kind).toBe('unreachable');
    });
  });
});

// 既定の時間の上限は、ふつうの呼び出しが 30 秒、生成が 10 分（#13 の約束）。待つのではなく、上限として渡る値を絶対の数で見る
describe('ForgeBackend default time limits', () => {
  let forge: MockForge;
  beforeEach(async () => {
    forge = await startMockForge();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await forge.close();
  });

  it('limits ordinary calls to 30 seconds and generation to 10 minutes', async () => {
    const limits = vi.spyOn(AbortSignal, 'timeout');
    const backend = new ForgeBackend({ baseUrl: forge.url });

    await backend.probe();
    expect(limits.mock.calls.map(([ms]) => ms)).toContain(30_000);
    expect(limits.mock.calls.map(([ms]) => ms)).not.toContain(600_000);

    limits.mockClear();
    forge.route('POST /sdapi/v1/txt2img', () => undefined);
    const stop = new AbortController();
    const generating = backend.generate(
      {
        prompt: 'a',
        negativePrompt: '',
        loras: [],
        steps: 1,
        cfgScale: 1,
        width: 8,
        height: 8,
        batchSize: 1,
        controlnet: [],
      },
      stop.signal,
    );
    await vi.waitFor(() => expect(limits.mock.calls.map(([ms]) => ms)).toContain(600_000));
    stop.abort();
    await generating.catch(() => undefined);
  });
});
