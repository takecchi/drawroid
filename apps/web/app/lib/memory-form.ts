import type { MemoryItemDetail, SaveMemoryInput } from '@drawroid/swr';

export type MemoryItem = MemoryItemDetail['item'];

// tags は1つの文字列で持つ: 入力途中の「a,」や空欄を、配列に直すと消えてしまうため
export interface MemoryFormValues {
  body: string;
  tags: string;
  scope: MemoryItem['scope'];
}

export function memoryToFormValues(item: MemoryItem): MemoryFormValues {
  return { body: item.body, tags: item.tags.join(', '), scope: item.scope };
}

// 全角の区切りも受ける: 日本語の入力のまま打っても別々の tag になるように
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[,、，]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  return [...new Set(tags)];
}

// 上限の超過は整形せずそのまま送る: 黙って切ると、直したつもりの本文が違うものになる。サーバの検証が 400 で理由を返す
export function buildSaveInput(
  values: MemoryFormValues,
  expectedUpdatedAt: string,
): SaveMemoryInput {
  return {
    body: values.body.trim(),
    tags: parseTags(values.tags),
    scope: values.scope,
    expectedUpdatedAt,
  };
}

/** 一覧に出す本文の頭。改行は空白にして1行にする */
export function bodyHead(body: string, maxChars = 40): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  const chars = [...oneLine];
  return chars.length <= maxChars ? oneLine : `${chars.slice(0, maxChars).join('')}…`;
}
