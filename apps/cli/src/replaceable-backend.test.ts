import { StubBackend } from '@drawroid/core/testing';
import { describe, expect, it } from 'vitest';

import { ReplaceableBackend } from './replaceable-backend.js';

const request = {
  prompt: 'a cat',
  negativePrompt: '',
  loras: [],
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
  batchSize: 1,
};

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

  it('lets a running generation finish on the backend it started on', async () => {
    const first = new StubBackend({ generateDelayMs: 20 });
    const second = new StubBackend();
    const backend = new ReplaceableBackend(first);
    const running = backend.generate(request, new AbortController().signal);
    backend.replace(second);
    const result = await running;
    expect(result.images).toHaveLength(1);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toEqual([]);
  });

  it('sends interrupt to the current backend, not the one a generation started on', async () => {
    const first = new StubBackend();
    const second = new StubBackend();
    const backend = new ReplaceableBackend(first);
    backend.replace(second);
    await backend.interrupt();
    expect(first.interruptCount).toBe(0);
    expect(second.interruptCount).toBe(1);
  });
});
