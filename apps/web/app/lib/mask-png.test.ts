import { MAX_MASK_BYTES as SERVER_MAX_MASK_BYTES } from '@drawroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeMaskPng, MAX_MASK_BYTES, maskPngProblem } from './mask-png';

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
    expect(problem).toContain('「ひとつ戻す」で筆を減らす');
  });

  // 今の大きさは切り上げて言う: 少しだけ超えたときに「8MB を超えている（8.0MB）」と、上限と同じ値を出さないように
  it('rounds the size of the mask up, so that it never reads as the limit itself', () => {
    expect(maskPngProblem(base64Of(MAX_MASK_BYTES + 1))).toContain('（8.1MB）');
  });
});

describe('encodeMaskPng', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 頭（data:image/png;base64,）を付けない: サーバは素の base64 だけを受け、送る前の大きさの確かめ（maskPngProblem）も
  // 素の base64 を数えるため。頭が付くと、画面では通ったマスクをサーバが断る
  it('gives the PNG as bare base64, the form the server takes and the size check counts', async () => {
    // node には canvas が無い: canvas が作った PNG のバイト列だけを決めて返す
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const context = {
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => context,
        toBlob: (resolve: (blob: Blob) => void) => resolve(new Blob([png])),
      }),
    });

    const encoded = await encodeMaskPng([], { width: 4, height: 3 });

    expect(encoded).toBe(Buffer.from(png).toString('base64'));
  });
});
