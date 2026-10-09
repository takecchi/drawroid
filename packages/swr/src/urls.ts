/**
 * ジョブの画像の URL。会話のイベントは画像の参照（ジョブ・回・枚）だけを持つので、画面がここで URL にする。
 * 形は API の `imageUrls`（packages/api/src/iterations.ts）と同じでなければならない（urls.test.ts が縛る）。
 */
export function jobImageUrls(jobId: string, iteration: number, index: number) {
  const base = `/api/files/jobs/${jobId}/iterations/${iteration}/images/${index}`;
  return { url: `${base}.png`, previewUrl: `${base}.preview.webp` };
}
