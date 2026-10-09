import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type InvalidMemoryFile,
  isMemoryId,
  type MemoryItem,
  memoryItemSchema,
  type MemoryStore,
} from '@drawroid/core';

import { writeFileAtomic } from '../atomic.js';
import { formatMemoryFile, MEMORY_FILE_EXTENSION, parseMemoryFile } from './file.js';

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// id はそのままファイル名になる。API から来た id でデータディレクトリの外や一時ファイルを指せないようにする
function assertSafeId(id: string): void {
  if (!isMemoryId(id)) {
    throw new Error(`記憶の ID に使えない形: ${JSON.stringify(id)}`);
  }
}

// キャッシュを持たない: 人間がファイルを直接直したら、次の読み込みでそのまま反映されるようにするため
export function createFsMemoryStore(dir: string): MemoryStore {
  const pathOf = (id: string) => {
    assertSafeId(id);
    return join(dir, `${id}${MEMORY_FILE_EXTENSION}`);
  };
  const readText = (path: string) =>
    readFile(path, 'utf8').catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });

  return {
    async list() {
      const names = await readdir(dir).catch((error: unknown) => {
        if (isNotFound(error)) return [];
        throw error;
      });
      const items: MemoryItem[] = [];
      const invalid: InvalidMemoryFile[] = [];
      for (const name of names.sort()) {
        // 一時ファイル（.tmp-）や、エディタが残す隠しファイルは読まない
        if (name.startsWith('.') || !name.endsWith(MEMORY_FILE_EXTENSION)) continue;
        const id = name.slice(0, -MEMORY_FILE_EXTENSION.length);
        const text = await readText(join(dir, name));
        // readdir と読み込みのあいだに人間が消したもの
        if (text === null) continue;
        const parsed = parseMemoryFile(id, text);
        if (parsed.ok) items.push(parsed.item);
        else invalid.push({ id, reason: parsed.reason });
      }
      return { items, invalid };
    },

    async get(id) {
      const text = await readText(pathOf(id));
      if (text === null) return null;
      const parsed = parseMemoryFile(id, text);
      if (!parsed.ok) throw new Error(`記憶 ${id} のファイルを読めない: ${parsed.reason}`);
      return parsed.item;
    },

    async put(item) {
      const valid = memoryItemSchema.parse(item);
      const path = pathOf(valid.id);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(path, formatMemoryFile(valid));
    },

    async remove(id) {
      try {
        await unlink(pathOf(id));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}
