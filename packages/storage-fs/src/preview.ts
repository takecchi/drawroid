import sharp from 'sharp';

/** LLM に渡す縮小版の形式 */
export const PREVIEW_MEDIA_TYPE = 'image/webp';

/**
 * 画像から、LLM に渡す縮小版を作る。長辺を longEdge に収め、元より大きくはしない。
 */
// doctor も同じ関数で確かめの画像を作る: 別の形式で確かめると、本番の縮小版を読めないモデルでも通ってしまうため
export async function makePreview(source: Uint8Array, longEdge: number): Promise<Uint8Array> {
  const data = await sharp(source)
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .webp()
    .toBuffer();
  return new Uint8Array(data);
}
