import { describe, expect, it } from 'vitest';

import { conversationOfSource, conversationSource } from './memory-tools.js';

describe('conversationOfSource', () => {
  it('reads back the conversation a memory was learned in', () => {
    expect(conversationOfSource(conversationSource('20261009-094204-2c158a'))).toBe(
      '20261009-094204-2c158a',
    );
  });

  it('leaves a job ID alone', () => {
    expect(conversationOfSource('20261009-094037-484d9c')).toBeUndefined();
    expect(conversationOfSource('conversation:')).toBeUndefined();
  });
});
