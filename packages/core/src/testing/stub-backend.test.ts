import { describe, expect, expectTypeOf, it } from 'vitest';

import { generationRequestSchema, type ImageBackend } from '../backend.js';
import { BackendError } from '../backend-error.js';
import { describeImageBackendContract } from './image-backend-contract.js';
import { StubBackend } from './stub-backend.js';

describeImageBackendContract('StubBackend', {
  connected: async () => ({ backend: new StubBackend() }),
  unreachable: async () => {
    const backend = new StubBackend();
    backend.setUnreachable(true);
    return { backend };
  },
});

const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

describe('StubBackend', () => {
  it('has no progress, which the ImageBackend contract allows', () => {
    expectTypeOf<StubBackend>().not.toHaveProperty('progress');
    const backend: ImageBackend = new StubBackend();
    expect(backend.progress).toBeUndefined();
  });

  it('records what it was asked to generate', async () => {
    const backend = new StubBackend();
    await backend.generate(request, new AbortController().signal);
    expect(backend.requests).toEqual([request]);
  });

  it('picks a seed when the request leaves it out', async () => {
    const backend = new StubBackend();
    const { images } = await backend.generate(request, new AbortController().signal);
    expect(typeof images[0]?.seed).toBe('number');
  });

  it('fails the next generation with the given error, once', async () => {
    const backend = new StubBackend();
    backend.failNextGenerate(new BackendError('failed', 'out of memory'));
    await expect(backend.generate(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'failed',
    });
    await expect(backend.generate(request, new AbortController().signal)).resolves.toBeDefined();
  });

  it('stops a running generation when the signal is aborted', async () => {
    const backend = new StubBackend({ generateDelayMs: 10_000 });
    const controller = new AbortController();
    const running = backend.generate(request, controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('counts interrupts', async () => {
    const backend = new StubBackend();
    await backend.interrupt();
    expect(backend.interruptCount).toBe(1);
  });

  it('returns the candidates it was given, falling back to defaults for other kinds', async () => {
    const backend = new StubBackend({ candidates: { lora: [{ name: 'only-lora' }] } });
    expect(await backend.listCandidates('lora')).toEqual([{ name: 'only-lora' }]);
    expect((await backend.listCandidates('checkpoint')).length).toBeGreaterThan(0);
  });
});
