import { MAX_MASK_BYTES as SERVER_MAX_MASK_BYTES } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { MAX_MASK_BYTES, maskPngProblem } from './mask-png';

const base64Of = (bytes: number) => Buffer.from(new Uint8Array(bytes)).toString('base64');

describe('maskPngProblem', () => {
  // 画面は同じ値を自分で持つ（mask-png.ts）。ずれると、画面で通したマスクをサーバが断るか、サーバが受けるマスクを画面が断る
  it('lets a mask be as large as the server takes', () => {
    expect(MAX_MASK_BYTES).toBe(SERVER_MAX_MASK_BYTES);
  });

  it('passes a mask of exactly the size limit', () => {
    expect(maskPngProblem(base64Of(MAX_MASK_BYTES))).toBeUndefined();
  });

  // 上限だけを言わない: マスクは細い筆で細かく塗るほど大きくなるので、断られた人が何を変えれば通るかを読み取れるように
  it('refuses a mask over the size limit, saying how to paint it smaller', () => {
    const problem = maskPngProblem(base64Of(MAX_MASK_BYTES + 1));

    expect(problem).toContain(`${MAX_MASK_BYTES / 1024 / 1024}MB を超えている`);
    expect(problem).toContain('太い筆でまとめて塗り直す');
  });

  // 今の大きさは切り上げて言う: 少しだけ超えたときに「8MB を超えている（8.0MB）」と、上限と同じ値を出さないように
  it('rounds the size of the mask up, so that it never reads as the limit itself', () => {
    expect(maskPngProblem(base64Of(MAX_MASK_BYTES + 1))).toContain('（8.1MB）');
  });
});
