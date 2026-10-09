import { describe, expect, it } from 'vitest';

import type { InterventionRecord } from '../job/types.js';
import { createCarry } from './carry.js';
import { DEFAULT_BUDGET } from './budget.js';
import {
  activeMask,
  generatedImageRef,
  imageSourcesOf,
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
