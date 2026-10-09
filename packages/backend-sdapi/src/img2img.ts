import type { GenerationRequest, ResizeMode } from '@drawroid/core';

import type { ResolvedImages } from './images.js';

// 数で渡す: /sdapi/v1/img2img の resize_mode は int だけを受け付ける（modules/images.py の resize_image）
const RESIZE_MODE: Record<ResizeMode, number> = { stretch: 0, crop: 1, fill: 2 };

const INPAINTING_FILL = { fill: 0, original: 1, latentNoise: 2, latentNothing: 3 } as const;

/** /sdapi/v1/img2img だけにある欄（元画像・マスク・描き直しの強さ） */
export function img2imgFields(
  req: GenerationRequest,
  images: ResolvedImages,
): Record<string, unknown> {
  if (req.inpaint !== undefined) {
    const inpaint = req.inpaint;
    return {
      init_images: [images.base64(inpaint.image)],
      // 白い所を描き直す。反転はしない
      mask: images.base64(inpaint.mask),
      inpainting_mask_invert: 0,
      denoising_strength: inpaint.denoisingStrength,
      resize_mode: RESIZE_MODE[inpaint.resize],
      mask_blur: inpaint.maskBlur,
      // 省かない: API の既定（fill・塗った所だけ）は画面の既定（original・全体）と違い、黙って別の描き方になるため
      inpainting_fill: INPAINTING_FILL[inpaint.fill],
      inpaint_full_res: inpaint.area === 'masked',
      inpaint_full_res_padding: inpaint.padding,
      include_init_images: false,
    };
  }
  if (req.img2img !== undefined) {
    return {
      init_images: [images.base64(req.img2img.image)],
      denoising_strength: req.img2img.denoisingStrength,
      resize_mode: RESIZE_MODE[req.img2img.resize],
      // 応答に元画像を付けて返させない（parameters に base64 の原寸が載り、応答が膨らむため）
      include_init_images: false,
    };
  }
  return {};
}
