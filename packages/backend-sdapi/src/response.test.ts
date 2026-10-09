import { BackendError } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { readGenerationResponse } from './response.js';

/** PNG の印だけを持つ中身（中身は見ない試験なので、印だけで足りる） */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]).toString('base64');
const info = JSON.stringify({ seed: 7, all_seeds: [7, 8] });

function failureOf(run: () => unknown): BackendError {
  try {
    run();
  } catch (error) {
    if (error instanceof BackendError) return error;
    throw error;
  }
  throw new Error('失敗しなかった');
}

describe('readGenerationResponse', () => {
  // どちらのバックエンドの失敗かが文から分かる（Forge と書かない）
  it('names the product when fewer images come back than asked for', () => {
    const error = failureOf(() =>
      readGenerationResponse({ images: [PNG], info }, 2, { endpoint: 'txt2img', product: 'A1111' }),
    );

    expect(error.kind).toBe('bad_response');
    expect(error.message).toContain('A1111 の画面などで生成が中断された');
    expect(error.message).not.toContain('Forge');
  });

  it('names the product when an image is not a PNG', () => {
    const error = failureOf(() =>
      readGenerationResponse({ images: [JPEG], info }, 1, {
        endpoint: 'img2img',
        product: 'A1111',
      }),
    );

    expect(error.kind).toBe('bad_response');
    expect(error.message).toContain('A1111 の設定の画像形式');
    expect(error.message).not.toContain('Forge');
  });
});
