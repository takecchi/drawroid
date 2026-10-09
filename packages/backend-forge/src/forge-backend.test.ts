import { describeImageBackendContract } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ForgeBackend } from './forge-backend.js';
import { startMockForge, unusedUrl, type MockForge } from './test-support/mock-forge.js';

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
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
