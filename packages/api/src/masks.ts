import { MAX_MASK_BYTES } from '@drawroid/core';
import { z } from 'zod';

export { MAX_MASK_BYTES };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64 = /^(data:image\/png;base64,)?[A-Za-z0-9+/]*={0,2}$/;

/**
 * inpaint のマスク1枚。PNG を base64 で載せる。白い所を描き直す。
 */
// PNG だけを受ける: マスクは白黒（または透明）の境目がそのまま意味を持ち、JPEG の圧縮で境目が崩れるため
export const maskUploadSchema = z
  .object({
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_MASK_BYTES / 3) * 4)
      .regex(BASE64, { message: 'base64 ではない' }),
  })
  .transform((upload, ctx): Uint8Array => {
    const bytes = new Uint8Array(Buffer.from(upload.data.replace('data:image/png;base64,', ''), 'base64'));
    if (bytes.byteLength > MAX_MASK_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: `マスクが ${MAX_MASK_BYTES} バイトを超えている`,
      });
      return z.NEVER;
    }
    if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'マスクが PNG ではない' });
      return z.NEVER;
    }
    return bytes;
  });
