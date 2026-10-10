import { mkdir } from 'node:fs/promises';

import { sweepTempFiles } from './atomic.js';
import { dataPaths, type DataPaths } from './paths.js';

export interface InitializedDataDir {
  paths: DataPaths;
  sweptTempFiles: string[];
}

// 何度呼んでもよい。足りないディレクトリだけを作り、既にあるファイルには、前回の書きかけの一時ファイルを片付けるほかは触れない
export async function initDataDir(root: string): Promise<InitializedDataDir> {
  const paths = dataPaths(root);
  for (const dir of [paths.root, paths.memory, paths.llmCalls, paths.jobs]) {
    await mkdir(dir, { recursive: true });
  }
  const sweptTempFiles = await sweepTempFiles(paths.root);
  return { paths, sweptTempFiles };
}
