import { describe, expect, it } from 'vitest';

import { generationRequestSchema } from '../backend.js';
import type { JobStore } from '../job/store.js';
import type { InterventionRecord } from '../job/types.js';
import { createCarry } from './carry.js';
import { DEFAULT_BUDGET } from './budget.js';
import {
  activeMask,
  generatedImageRef,
  imageSourcesOf,
  loadRequestImages,
  maskImageRef,
  parseInputImageRef,
  referenceImageRef,
} from './image-sources.js';

const mask = (interventionId: string, usedInIteration?: number): InterventionRecord => ({
  kind: 'mask',
  interventionId,
  receivedAt: '2026-10-09T00:00:00Z',
  image: { iteration: 1, index: 0 },
  ...(usedInIteration === undefined ? {} : { usedInIteration }),
});

describe('image references in a generation request', () => {
  it('reads back what it wrote, for generated images, reference images and masks', () => {
    expect(parseInputImageRef(generatedImageRef(3, 1))).toEqual({
      kind: 'image',
      iteration: 3,
      index: 1,
    });
    expect(parseInputImageRef(referenceImageRef('000002'))).toEqual({
      kind: 'ref',
      refId: '000002',
    });
    expect(parseInputImageRef(maskImageRef('000005'))).toEqual({ kind: 'mask', maskId: '000005' });
  });

  it('does not read a reference of a form it does not know', () => {
    expect(parseInputImageRef('iterations/0001/images/0.png')).toBeUndefined();
  });
});

describe('imageSourcesOf', () => {
  it('offers the best and the latest result, and the reference images, under their keys', () => {
    const carry = {
      ...createCarry('海辺', DEFAULT_BUDGET).carry,
      best: { iteration: 1, imageIndex: 2, score: 0.9, params: {}, issues: [], nextChange: '' },
      latest: { iteration: 2, imageIndex: 0, score: 0.5, params: {}, issues: [], nextChange: '' },
      references: [{ refId: '000001', gist: '立ち姿' }],
    };

    expect(imageSourcesOf(carry)).toEqual([
      { key: 'best', ref: 'image:1-2' },
      { key: 'latest', ref: 'image:2-0' },
      { key: 'ref:000001', ref: 'ref:000001' },
    ]);
  });

  it('offers nothing before the first image and without reference images', () => {
    expect(imageSourcesOf(createCarry('海辺', DEFAULT_BUDGET).carry)).toEqual([]);
  });
});

describe('activeMask (Issue #5 H)', () => {
  it('is the newest mask while it has not been used', () => {
    expect(activeMask([mask('000001'), mask('000002')])?.interventionId).toBe('000002');
  });

  it('is gone once the newest mask has been used, without going back to an older one', () => {
    expect(activeMask([mask('000001'), mask('000002', 3)])).toBeUndefined();
  });

  it('is gone when there is no mask', () => {
    expect(activeMask([])).toBeUndefined();
  });
});

describe('loadRequestImages', () => {
  const png = new Uint8Array([1, 2, 3]);
  // 参照画像 000001 だけがある置き場所
  const store = {
    readImage: async () => undefined,
    readMask: async () => undefined,
    readReferenceImage: async (key: { refId: string }) =>
      key.refId === '000001' ? { data: png, mediaType: 'image/png' } : undefined,
  } as unknown as JobStore;
  const request = (image: string, mask: string) =>
    generationRequestSchema.parse({
      prompt: 'x',
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
      inpaint: { image, mask, denoisingStrength: 0.5 },
    });

  it('reads every image the request points at', async () => {
    const images = await loadRequestImages(store, 'job', request('ref:000001', 'ref:000001'));
    expect([...images.keys()]).toEqual(['ref:000001']);
    expect(images.get('ref:000001')?.data).toEqual(png);
  });

  it('throws and names every missing reference when the store lacks an image', async () => {
    await expect(
      loadRequestImages(store, 'job', request('image:1-0', 'mask:000009')),
    ).rejects.toThrow('要求が指す画像が無い: image:1-0, mask:000009');
  });
});
