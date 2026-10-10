import { BackendError } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_BYTES } from './client.js';
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

  it.each(['Forge', 'A1111'])('names %s when the info cannot be read', (product) => {
    const error = failureOf(() =>
      readGenerationResponse({ images: [PNG], info: 'not json' }, 1, {
        endpoint: 'txt2img',
        product,
      }),
    );

    expect(error.kind).toBe('bad_response');
    expect(error.message).toContain(product);
    expect(error.message).not.toContain(product === 'Forge' ? 'A1111' : 'Forge');
  });

  /** PNG の印で始まる、bytes バイトの画像の base64 */
  const pngOf = (bytes: number) => {
    const png = Buffer.alloc(bytes);
    Buffer.from(PNG, 'base64').copy(png);
    return png.toString('base64');
  };

  it('refuses an image over 64 MB, saying how large an image may be', () => {
    const error = failureOf(() =>
      readGenerationResponse({ images: [pngOf(MAX_IMAGE_BYTES + 1)], info }, 1, {
        endpoint: 'txt2img',
        product: 'Forge',
      }),
    );

    expect(MAX_IMAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(error.kind).toBe('bad_response');
    expect(error.message).toContain('txt2img の画像が大きすぎる（1枚 64 MB まで）');
    expect(error.message).toContain('Forge');
  });

  // 上限は戻したあとの大きさで測る。base64 の長さ（約 4/3 倍）で測ると、上限より小さい画像まで断ってしまう
  it('takes an image under 64 MB whose base64 is longer than 64 MB', () => {
    const result = readGenerationResponse({ images: [pngOf(60 * 1024 * 1024)], info }, 1, {
      endpoint: 'txt2img',
      product: 'Forge',
    });

    expect(result.images[0]!.png.byteLength).toBe(60 * 1024 * 1024);
  });
});
