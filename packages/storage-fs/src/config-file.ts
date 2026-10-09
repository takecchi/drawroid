import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { writeJsonAtomic } from './atomic.js';

/** config.json を JSON のオブジェクトとして読む。ファイルが無ければ空 */
export async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} が JSON のオブジェクトではない`);
  }
  return parsed as Record<string, unknown>;
}

// ファイルごとの待ち行列。読んで変えて書く間に別の書き込みが割り込むと、先に書いた変更が消えるため
const queues = new Map<string, Promise<unknown>>();

/**
 * config.json を読み、change で変えて、原子的に書く。同じファイルへの更新は、このプロセスの中で1つずつ行う。
 * config.json を書く口（LLM の設定・バックエンドの設定・許可）は、すべてこれを通す。
 *
 * 別のプロセスからの同時の書き込み（2つ目の drawroid や、人間の手での編集など）は防がない（範囲外）。
 */
export async function updateConfigObject(
  configPath: string,
  change: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const key = resolve(configPath);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const updated = change(await readConfigObject(configPath));
      await writeJsonAtomic(configPath, updated);
      return updated;
    });
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
