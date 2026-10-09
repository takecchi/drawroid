import { imageUrls } from '@drawroid/api';
import { describe, expect, it } from 'vitest';

import { conversationUploadUrl, jobImageUrls } from './urls.js';

describe('jobImageUrls', () => {
  it('builds the same image URLs as the API serves', () => {
    expect(jobImageUrls('20261009-153112-k3f9', 3, 1)).toEqual(
      imageUrls('20261009-153112-k3f9', 3, 1),
    );
  });
});

describe('conversationUploadUrl', () => {
  it('points at the image a person attached in the conversation', () => {
    expect(conversationUploadUrl('c1', '20261009-153112-k3f9')).toBe(
      '/api/conversations/c1/uploads/20261009-153112-k3f9',
    );
  });

  it('escapes the IDs, so that an odd ID stays one part of the path', () => {
    expect(conversationUploadUrl('c/1', '../x?y')).toBe(
      '/api/conversations/c%2F1/uploads/..%2Fx%3Fy',
    );
  });
});
