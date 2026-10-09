import { BackendBusyError } from '@drawroid/api';
import {
  BackendError,
  generationRequestSchema,
  type GenerationImages,
  type GenerationRequest,
} from '@drawroid/core';
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

// 中の backend が受け取った画像を残す: 包みが引数を落としても型では見つからないため、届いたものを見る
class ImageRecordingBackend extends StubBackend {
  readonly receivedImages: (GenerationImages | undefined)[] = [];

  override generate(req: GenerationRequest, signal: AbortSignal, images?: GenerationImages) {
    this.receivedImages.push(images);
    return super.generate(req, signal, images);
  }
}

describe('ReplaceableBackend', () => {
  it('passes the input images on to the backend it holds', async () => {
    const inner = new ImageRecordingBackend();
    const backend = new ReplaceableBackend(inner);
    const img2img = generationRequestSchema.parse({
      prompt: 'a cat',
      steps: 4,
      cfgScale: 7,
      width: 64,
      height: 64,
      img2img: { image: 'source', denoisingStrength: 0.5 },
    });
    const images: GenerationImages = new Map([
      ['source', { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
    ]);

    await backend.generate(img2img, new AbortController().signal, images);

    expect(inner.receivedImages).toEqual([images]);
  });

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
