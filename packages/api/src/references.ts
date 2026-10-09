import { REFERENCE_MEDIA_TYPES, type NewReference } from '@drawroid/core';
import { z } from 'zod';

/** 参照画像1枚の大きさの上限（base64 を戻したあとのバイト数）。クローンが決めた値 */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
/** 1回の要求で添えられる参照画像の枚数。クローンが決めた値 */
export const MAX_REFERENCES_PER_REQUEST = 4;

// 先頭のバイトで形式を確かめる: 宣言だけを信じると、画像でないものや別の形式のものを refs/ に置いて、縮小の段で落ちるため
const SIGNATURES: Record<(typeof REFERENCE_MEDIA_TYPES)[number], (bytes: Uint8Array) => boolean> = {
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
};

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 参照画像1枚。画像は base64 で載せる（JSON の本文のまま、ほかの口と同じ validator を通せるように） */
export const referenceUploadSchema = z
  .object({
    mediaType: z.enum(REFERENCE_MEDIA_TYPES),
    // 戻す前の長さでも締める: 上限を大きく超える文字列を、丸ごと戻してから断ることにならないように
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_REFERENCE_BYTES / 3) * 4)
      .regex(BASE64, { message: 'base64 ではない' }),
    /** 人間が添えた用途の言葉（「この構図で」など） */
    note: z.string().trim().min(1).max(200).optional(),
  })
  .transform((upload, ctx): NewReference => {
    const bytes = new Uint8Array(Buffer.from(upload.data, 'base64'));
    if (bytes.byteLength > MAX_REFERENCE_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: `画像が ${MAX_REFERENCE_BYTES} バイトを超えている`,
      });
      return z.NEVER;
    }
    if (!SIGNATURES[upload.mediaType](bytes)) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: `${upload.mediaType} の画像ではない`,
      });
      return z.NEVER;
    }
    return {
      data: bytes,
      mediaType: upload.mediaType,
      ...(upload.note === undefined ? {} : { note: upload.note }),
    };
  });

export const referenceUploadsSchema = z
  .array(referenceUploadSchema)
  .max(MAX_REFERENCES_PER_REQUEST);
