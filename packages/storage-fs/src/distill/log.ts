import { readFile } from 'node:fs/promises';

import { type DistillEntry, distillFileSchema, type DistillLog } from '@drawroid/core';

import { writeJsonAtomic } from '../atomic.js';
import { isJobId } from '../job-store.js';
import { dataPaths } from '../paths.js';

/**
 * 蒸留の記録を、データディレクトリ root の下の、ジョブのディレクトリの distill.json に追記する。
 */
// 追記でもファイルを丸ごと原子的に書き直す: 末尾に書き足す形だと、途中で落ちたときに壊れた JSON が残るため。
// ジョブのディレクトリは作らない: 人間が消したジョブを、蒸留の記録だけで生き返らせないため
export function createFsDistillLog(root: string): DistillLog {
  const paths = dataPaths(root);
  // jobId の検査を FsJobStore と揃える: jobId はそのままディレクトリ名になり、外を指せてはいけないため
  const pathOf = (jobId: string) => {
    if (!isJobId(jobId)) throw new Error(`jobId の形ではない: ${jobId}`);
    return paths.jobFiles(jobId).distill;
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
