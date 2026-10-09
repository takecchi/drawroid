import { describe, expect, it } from 'vitest';
import { clipText, estimateImageTokens } from './estimate.js';

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
