import { describe, expect, it } from 'vitest';

import { formatImageKey, parseImageKey } from './selection.js';

describe('image keys', () => {
  it('names an image by its iteration and index, and reads the name back', () => {
    expect(formatImageKey({ iteration: 12, index: 3 })).toBe('12-3');
    expect(parseImageKey('12-3')).toEqual({ iteration: 12, index: 3 });
  });

  it('refuses anything that is not an iteration and an index', () => {
    for (const key of ['0-1', '1', '1-', '-1', '1-a', '../1-1', '1-1.json', '01-1']) {
      expect(parseImageKey(key)).toBeUndefined();
    }
  });
});
