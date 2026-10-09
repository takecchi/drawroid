import {
  BackendError,
  type GenerationImages,
  type GenerationRequest,
  type InputImageRef,
  inputImageRefsOf,
} from '@drawroid/core';

/** 要求が指す画像の中身を、バックエンドに渡す base64 にしたもの */
export interface ResolvedImages {
  base64(ref: InputImageRef): string;
}

/**
 * 要求が指す画像の中身がそろっているかを、バックエンドに何かを頼む前に確かめる。
 */
export function resolveImages(req: GenerationRequest, images: GenerationImages): ResolvedImages {
  const missing = inputImageRefsOf(req).filter((ref) => !images.has(ref));
  if (missing.length > 0) {
    throw new BackendError('failed', `画像の中身が渡されていない: ${missing.join(', ')}`);
  }
  return {
    base64(ref) {
      const image = images.get(ref);
      if (image === undefined) throw new BackendError('failed', `画像 ${ref} の中身が無い`);
      // data URL にしない: Forge・A1111 は素の base64 も data:image/ 付きも受け付け、素の方が短い（modules/api/api.py の decode_base64_to_image）
      return Buffer.from(image.data).toString('base64');
    },
  };
}
