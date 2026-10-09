// MAX_REFERENCE_BYTES の TSDoc「参照画像1枚の大きさの上限」の境目（#67 の 27-20）
import { describe, expect, it } from 'vitest';

import { MAX_REFERENCE_BYTES, referenceUploadSchema } from './references.js';

/** 先頭が PNG の印で、全体が bytes バイトの本文 */
function pngOf(bytes: number) {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { mediaType: 'image/png' as const, data: Buffer.from(data).toString('base64') };
}

describe('the size limit of a reference image', () => {
  it('accepts an image of exactly the limit and refuses one byte more', () => {
    expect(referenceUploadSchema.safeParse(pngOf(MAX_REFERENCE_BYTES)).success).toBe(true);
    const over = referenceUploadSchema.safeParse(pngOf(MAX_REFERENCE_BYTES + 1));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toContain('バイトを超えている');
  });
});
