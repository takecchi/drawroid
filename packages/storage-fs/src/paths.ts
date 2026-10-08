import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// データディレクトリの中のパスは、すべてここで組み立てる。置き方を変えるときに直す場所を1つにするため
export const TEMP_FILE_PREFIX = '.tmp-';

export interface DataDirSource {
  cliArg?: string | undefined;
  env?: string | undefined;
  home?: string;
  cwd?: string;
}

// 優先順位は CLI 引数 > 環境変数（DRAWROID_HOME）> 既定（~/.drawroid）
export function resolveDataDir({
  cliArg,
  env,
  home = homedir(),
  cwd = process.cwd(),
}: DataDirSource): string {
  const chosen = nonEmpty(cliArg) ?? nonEmpty(env);
  if (chosen === undefined) return join(home, '.drawroid');
  return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function dataPaths(root: string) {
  const jobs = join(root, 'jobs');
  return {
    root,
    config: join(root, 'config.json'),
    candidateNotes: join(root, 'candidate-notes.json'),
    memory: join(root, 'memory'),
    llmCalls: join(root, 'llm-calls'),
    jobs,
    job: (jobId: string) => join(jobs, jobId),
  };
}

export type DataPaths = ReturnType<typeof dataPaths>;
