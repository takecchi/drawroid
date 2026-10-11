import { describe, expect, it } from 'vitest';

import { previewRequest } from './job-labels';

describe('previewRequest', () => {
  // 数えるのは見える文字: 絵文字のような2つの単位でできた文字を、途中で割って化けさせないため
  it('counts a character made of two units as one, and does not cut it in half', () => {
    expect(previewRequest('🐱'.repeat(60))).toBe('🐱'.repeat(60));
    expect(previewRequest('🐱'.repeat(61))).toBe(`${'🐱'.repeat(60)}…`);
  });
});
