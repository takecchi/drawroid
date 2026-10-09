/**
 * ジョブの画像の URL。会話のイベントは画像の参照（ジョブ・回・枚）だけを持つので、画面がここで URL にする。
 * 形は API の `imageUrls`（packages/api/src/iterations.ts）と同じでなければならない（urls.test.ts が縛る）。
 */
export function jobImageUrls(jobId: string, iteration: number, index: number) {
  const base = `/api/files/jobs/${jobId}/iterations/${iteration}/images/${index}`;
  return { url: `${base}.png`, previewUrl: `${base}.preview.webp` };
}

/**
 * 会話で人が添えた画像の URL（`GET /api/conversations/:conversationId/uploads/:uploadId`）。
 * 会話のイベントは送り込んだ画像の ID だけを持つので、画面がここで URL にする
 */
export function conversationUploadUrl(conversationId: string, uploadId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/uploads/${encodeURIComponent(uploadId)}`;
}
