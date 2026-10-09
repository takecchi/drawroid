import { type MemoryItem, memoryItemSchema } from '@drawroid/core';
import { Document, isSeq, parse } from 'yaml';

export const MEMORY_FILE_EXTENSION = '.md';

// 人間がエディタで保存した形（BOM・CRLF）も読めるようにする
const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export type ParsedMemoryFile = { ok: true; item: MemoryItem } | { ok: false; reason: string };

// id はファイル名から取る: front matter に書かれた id より、人間が見ているファイル名を正とするため
export function parseMemoryFile(id: string, text: string): ParsedMemoryFile {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return { ok: false, reason: '先頭に --- で囲んだ front matter が無い' };
  const [, frontMatter = '', body = ''] = match;

  let meta: unknown;
  try {
    meta = parse(frontMatter);
  } catch (error) {
    return {
      ok: false,
      reason: `front matter を YAML として読めない: ${(error as Error).message}`,
    };
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { ok: false, reason: 'front matter が「名前: 値」の並びになっていない' };
  }

  const result = memoryItemSchema.safeParse({ ...meta, id, body: body.trim() });
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(全体)'}: ${issue.message}`,
    );
    return { ok: false, reason: issues.join('; ') };
  }
  return { ok: true, item: result.data };
}

export function formatMemoryFile(item: MemoryItem): string {
  const doc = new Document({
    tags: item.tags,
    scope: item.scope,
    sources: item.sources,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
  // 一覧は1行に並べる: 人間が front matter を一目で読めるように
  for (const key of ['tags', 'sources']) {
    const node = doc.get(key, true);
    if (isSeq(node)) node.flow = true;
  }
  return `---\n${doc.toString()}---\n${item.body}\n`;
}
