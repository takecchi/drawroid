import { BackendBusyError } from '@drawroid/api';
import { BackendError, generationRequestSchema } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { describe, expect, it } from 'vitest';

import { ReplaceableBackend } from './replaceable-backend.js';

// schema を通して作る: 要求に欄が足されても、既定値のある欄はここで埋まるため
const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

describe('ReplaceableBackend', () => {
  it('delegates to the backend it was given', async () => {
    const first = new StubBackend();
    const backend = new ReplaceableBackend(first);
    await backend.generate(request, new AbortController().signal);
    expect(first.requests).toHaveLength(1);
    expect(await backend.listCandidates('lora')).toEqual(await first.listCandidates('lora'));
  });

  it('sends generations to the new backend after replace', async () => {
    const first = new StubBackend();
    const second = new StubBackend();
    const backend = new ReplaceableBackend(first);
    backend.replace(second);
    await backend.generate(request, new AbortController().signal);
    expect(first.requests).toEqual([]);
    expect(second.requests).toHaveLength(1);
  });

  it('refuses to replace while a generation runs, so interrupt still reaches it', async () => {
    const first = new StubBackend({ generateDelayMs: 20 });
    const second = new StubBackend();
    const backend = new ReplaceableBackend(first);
    const running = backend.generate(request, new AbortController().signal);
    expect(() => backend.replace(second)).toThrow(BackendBusyError);
    await backend.interrupt();
    expect(first.interruptCount).toBe(1);
    await running;
    expect(second.requests).toEqual([]);
  });

  it('can be replaced again once the generation has ended, even when it failed', async () => {
    const first = new StubBackend();
    first.failNextGenerate(new BackendError('failed', 'out of memory'));
    const backend = new ReplaceableBackend(first);
    await expect(backend.generate(request, new AbortController().signal)).rejects.toThrow();
    const second = new StubBackend();
    expect(backend.replace(second)).toBe(first);
  });
});
