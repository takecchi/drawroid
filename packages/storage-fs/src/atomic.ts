import { randomBytes } from 'node:crypto';
import { open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { TEMP_FILE_PREFIX } from './paths.js';

// 同じディレクトリの一時ファイルに書いてから rename する: rename は同じファイルシステムの中でだけ原子的なので、別の場所（os.tmpdir）に書くと途中で落ちたときに半端なファイルが残りうるため
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  const temp = join(dir, `${TEMP_FILE_PREFIX}${randomBytes(6).toString('hex')}-${basename(path)}`);
  const file = await open(temp, 'wx');
  try {
    await file.writeFile(data);
    // fsync してから rename する: しないと、電源断のあとに「名前は新しいが中身が空」のファイルが残りうるため
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await syncDir(dir);
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  // 人間がディレクトリを開いて読めるように整形して書く
  return writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r').catch(() => null);
  if (handle === null) return;
  try {
    // ディレクトリの fsync を許さない環境（Windows など）がある。rename そのものは済んでいるので、失敗しても書き込みの失敗にしない
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

// 落ちたプロセスが残した一時ファイルを片付ける。読み手は一時ファイルを無視するので、片付けは起動時にまとめて行えば足りる
export async function sweepTempFiles(root: string): Promise<string[]> {
  const removed: string[] = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(TEMP_FILE_PREFIX)) continue;
    const path = join(entry.parentPath, entry.name);
    await unlink(path);
    removed.push(path);
  }
  return removed;
}
