// @vitest-environment jsdom
import { MAX_REFERENCES_PER_REQUEST as SERVER_MAX_REFERENCES } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import {
  buildReferenceUpload,
  buildReferenceUploads,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCES_PER_REQUEST,
  normalizeReferenceNote,
  referenceFileProblem,
} from './reference-upload';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47];

function pngFile(name = 'ref.png', bytes: number[] = PNG_HEAD): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

function problem(file: { name: string; type: string; size: number }, attached = 0) {
  return referenceFileProblem(file, attached);
}

// 画面は同じ値を自分で持つ（reference-upload.ts）。ずれると、画面で選べた画像をサーバが断るか、サーバが受ける枚数を画面が選ばせない
describe('the number of reference images', () => {
  it('lets a request carry as many images as the server takes', () => {
    expect(MAX_REFERENCES_PER_REQUEST).toBe(SERVER_MAX_REFERENCES);
  });
});

describe('buildReferenceUpload', () => {
  it('turns a file into the media type, base64 data and trimmed note to send', async () => {
    const built = await buildReferenceUpload({ file: pngFile(), note: '  この構図で  ' });

    expect(built).toEqual({
      ok: true,
      value: { mediaType: 'image/png', data: 'iVBORw==', note: 'この構図で' },
    });
  });

  it('leaves the note out when it is only whitespace', async () => {
    const built = await buildReferenceUpload({ file: pngFile(), note: ' \n ' });

    expect(built.ok && 'note' in built.value).toBe(false);
  });

  it('refuses a note longer than 200 characters after trimming', async () => {
    const built = await buildReferenceUpload({ file: pngFile(), note: 'あ'.repeat(201) });

    expect(built.ok).toBe(false);
    expect(!built.ok && built.reason).toContain('200');
  });

  it('accepts a note of exactly 200 characters padded with whitespace', async () => {
    const built = await buildReferenceUpload({ file: pngFile(), note: ` ${'あ'.repeat(200)} ` });

    expect(built.ok).toBe(true);
  });

  it('refuses a type other than PNG, JPEG and WebP with the file name', async () => {
    const gif = new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' });

    const built = await buildReferenceUpload({ file: gif, note: '' });

    expect(built.ok).toBe(false);
    expect(!built.ok && built.reason).toContain('a.gif');
    expect(!built.ok && built.reason).toContain('image/gif');
  });
});

describe('referenceFileProblem', () => {
  it('passes JPEG and WebP of the maximum size', () => {
    expect(problem({ name: 'a', type: 'image/jpeg', size: MAX_REFERENCE_BYTES })).toBeUndefined();
    expect(problem({ name: 'a', type: 'image/webp', size: 1 })).toBeUndefined();
  });

  it('refuses a file over 8MB', () => {
    expect(
      problem({ name: 'big.png', type: 'image/png', size: MAX_REFERENCE_BYTES + 1 }),
    ).toContain('8MB');
  });

  it('refuses an empty file', () => {
    expect(problem({ name: 'e.png', type: 'image/png', size: 0 })).toContain('空');
  });

  it('refuses a file once the maximum count is already attached', () => {
    const file = { name: 'x.png', type: 'image/png', size: 10 };

    expect(problem(file, MAX_REFERENCES_PER_REQUEST - 1)).toBeUndefined();
    expect(problem(file, MAX_REFERENCES_PER_REQUEST)).toContain(`${MAX_REFERENCES_PER_REQUEST} 枚`);
  });
});

describe('buildReferenceUploads', () => {
  it('builds every upload in order', async () => {
    const built = await buildReferenceUploads([
      { file: pngFile('1.png'), note: 'a' },
      { file: pngFile('2.png'), note: '' },
    ]);

    expect(built.ok && built.value.map((upload) => upload.note)).toEqual(['a', undefined]);
  });

  it('refuses all of them when there are more than the maximum count', async () => {
    const items = Array.from({ length: MAX_REFERENCES_PER_REQUEST + 1 }, (_, i) => ({
      file: pngFile(`${i}.png`),
      note: '',
    }));

    const built = await buildReferenceUploads(items);

    expect(built.ok).toBe(false);
  });
});

describe('normalizeReferenceNote', () => {
  it('turns a blank note into no note', () => {
    expect(normalizeReferenceNote('   ')).toEqual({ ok: true, value: undefined });
  });
});
