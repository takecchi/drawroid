import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type DistillEntry, distillFileSchema, type DistillLog } from '@drawroid/core';

import { writeJsonAtomic } from '../atomic.js';

export const DISTILL_FILE_NAME = 'distill.json';

// jobId はそのままディレクトリ名になる。ジョブのディレクトリの外を指せないようにする
function assertSafeJobId(jobId: string): void {
  if (jobId === '' || jobId.startsWith('.') || /[/\\\0]/.test(jobId)) {
    throw new Error(`ジョブの ID に使えない形: ${JSON.stringify(jobId)}`);
  }
}

/**
 * 蒸留の記録を、ジョブのディレクトリの distill.json に追記する。
 */
// 追記でもファイルを丸ごと原子的に書き直す: 末尾に書き足す形だと、途中で落ちたときに壊れた JSON が残るため。
// ジョブのディレクトリは作らない: 人間が消したジョブを、蒸留の記録だけで生き返らせないため
export function createFsDistillLog(jobsDir: string): DistillLog {
  const pathOf = (jobId: string) => {
    assertSafeJobId(jobId);
    return join(jobsDir, jobId, DISTILL_FILE_NAME);
  };
  // 同じジョブへの追記を順に並べる: 読んで足して書く間に別の追記が割り込むと、片方が消えるため
  const queues = new Map<string, Promise<unknown>>();

  async function readEntries(path: string): Promise<DistillEntry[]> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = distillFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`${path} を読めない: ${parsed.error.message}`);
    }
    return parsed.data.entries;
  }

  return {
    async append(jobId, entry) {
      const path = pathOf(jobId);
      const previous = queues.get(path) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const entries = await readEntries(path);
          await writeJsonAtomic(path, { jobId, entries: [...entries, entry] });
        });
      queues.set(path, next);
      try {
        await next;
      } finally {
        if (queues.get(path) === next) queues.delete(path);
      }
    },

    async read(jobId) {
      return readEntries(pathOf(jobId));
    },
  };
}
