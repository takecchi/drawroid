import type { ReferenceUpload } from '@drawroid/swr';

import type { FormResult } from './stop-conditions-form';

// サーバ（core の job/types.ts。api もそれを使う）と同じ値。同じであることは試験で縛る（用途の言葉の上限と形式の並びも同じ）。
// api を runtime で import しない: サーバ側の依存（zod の transform や Buffer）をブラウザの成果物へ引き込まないため
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCES_PER_REQUEST = 4;
export const MAX_REFERENCE_NOTE_LENGTH = 200;
export const REFERENCE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

type MediaType = (typeof REFERENCE_MEDIA_TYPES)[number];

/** 添える画像と用途の言葉。File は選ばれたまま持ち、base64 は送る直前にだけ作る */
export interface AttachedReference {
  id: string;
  file: File;
  note: string;
}

function isMediaType(type: string): type is MediaType {
  return (REFERENCE_MEDIA_TYPES as readonly string[]).includes(type);
}

/** 断る理由。通るときは undefined。attached はすでに添えてある枚数 */
export function referenceFileProblem(
  file: { name: string; type: string; size: number },
  attached: number,
): string | undefined {
  if (attached >= MAX_REFERENCES_PER_REQUEST) {
    return `${file.name}: 添えられるのは ${MAX_REFERENCES_PER_REQUEST} 枚まで。この画像を添えるなら、ほかの画像を外してから選び直す`;
  }
  if (!isMediaType(file.type)) {
    return `${file.name}: PNG・JPEG・WebP のどれかにする（${file.type === '' ? '種類が分からない' : file.type}）`;
  }
  if (file.size === 0) return `${file.name}: 中身が空`;
  if (file.size > MAX_REFERENCE_BYTES) {
    return `${file.name}: ${MAX_REFERENCE_BYTES / 1024 / 1024}MB を超えている`;
  }
  return undefined;
}

/** 空白だけの用途は付けない。長さは trim したあとで数える（api も trim してから測る） */
export function normalizeReferenceNote(note: string): FormResult<string | undefined> {
  const trimmed = note.trim();
  if (trimmed.length > MAX_REFERENCE_NOTE_LENGTH) {
    return {
      ok: false,
      reason: `用途の言葉は ${MAX_REFERENCE_NOTE_LENGTH} 文字まで（いまは ${trimmed.length} 文字）`,
    };
  }
  return { ok: true, value: trimmed === '' ? undefined : trimmed };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 分けて文字にする: 8MB を1度に String.fromCharCode へ渡すと引数の数が上限を超えるため
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 1枚を送る形にする。attached は、この1枚を数えない枚数 */
export async function buildReferenceUpload(
  item: Pick<AttachedReference, 'file' | 'note'>,
  attached = 0,
): Promise<FormResult<ReferenceUpload>> {
  const problem = referenceFileProblem(item.file, attached);
  if (problem !== undefined) return { ok: false, reason: problem };
  const note = normalizeReferenceNote(item.note);
  if (!note.ok) return { ok: false, reason: `${item.file.name}: ${note.reason}` };
  return {
    ok: true,
    value: {
      // referenceFileProblem が種類を確かめたあとなので、ここで MediaType に絞れる
      mediaType: item.file.type as MediaType,
      data: await toBase64(item.file),
      ...(note.value === undefined ? {} : { note: note.value }),
    },
  };
}

/** 投入の body 用。1枚でも断られるなら、どれも送らず理由を返す */
export async function buildReferenceUploads(
  items: readonly Pick<AttachedReference, 'file' | 'note'>[],
): Promise<FormResult<ReferenceUpload[]>> {
  const uploads: ReferenceUpload[] = [];
  for (const [index, item] of items.entries()) {
    const built = await buildReferenceUpload(item, index);
    if (!built.ok) return built;
    uploads.push(built.value);
  }
  return { ok: true, value: uploads };
}
