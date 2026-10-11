import { describe, expect, it } from 'vitest';
import { clipText, estimateImageTokens, estimateTextTokens } from './estimate.js';

describe('estimateTextTokens', () => {
  it('counts three ASCII characters as one token', () => {
    expect(estimateTextTokens('abcdefghijkl')).toBe(4);
  });

  it('rounds a partial group of ASCII characters up, so the estimate is never short', () => {
    expect(estimateTextTokens('abcd')).toBe(2);
  });

  it('counts each character outside ASCII as one token', () => {
    expect(estimateTextTokens('夕暮れの海')).toBe(5);
  });

  it('draws the ASCII line between U+007F and U+0080', () => {
    expect(estimateTextTokens('\u007f'.repeat(3))).toBe(1);
    expect(estimateTextTokens('\u0080'.repeat(3))).toBe(3);
  });
});

describe('estimateImageTokens', () => {
  it('counts one token per 750 square pixels of a square with the given long edge', () => {
    expect(estimateImageTokens(512)).toBe(350);
    expect(estimateImageTokens(1024)).toBe(1399);
  });
});

describe('clipText', () => {
  it('keeps a text that is exactly at the limit', () => {
    expect(clipText('abcde', 5)).toEqual({ text: 'abcde' });
  });

  it('cuts a text that is one over the limit and reports the original length', () => {
    expect(clipText('abcdef', 5)).toEqual({ text: 'abcde', clippedFrom: 6 });
  });
});
