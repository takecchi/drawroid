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
  const llmCalls = join(root, 'llm-calls');
  return {
    root,
    config: join(root, 'config.json'),
    candidateNotes: join(root, 'candidate-notes.json'),
    memory: join(root, 'memory'),
    llmCalls,
    /** ジョブに属さない LLM 呼び出しの記録 */
    llmCall: (callId: string) => join(llmCalls, `${callId}.json`),
    jobs,
    job: (jobId: string) => join(jobs, jobId),
    jobFiles: (jobId: string) => jobFiles(join(jobs, jobId)),
  };
}

// 回のディレクトリ名を0埋めにする: 名前の順がそのまま回の順になり、readdir の並べ替えだけで済むため
export function iterationDirName(iteration: number): string {
  return String(iteration).padStart(4, '0');
}

function jobFiles(dir: string) {
  const iterations = join(dir, 'iterations');
  const llmCalls = join(dir, 'llm-calls');
  const interventions = join(dir, 'interventions');
  const refs = join(dir, 'refs');
  const selections = join(dir, 'selections');
  return {
    dir,
    spec: join(dir, 'job.json'),
    state: join(dir, 'state.json'),
    /** ジョブが止まったときと選び直したときの蒸留の記録 */
    distill: join(dir, 'distill.json'),
    selections,
    /** 回の画像1枚への人間の最終選択（お気に入り・却下） */
    selection: (imageKey: string) => join(selections, `${imageKey}.json`),
    refs,
    /** 人間が添えた参照画像（原寸） */
    ref: (refId: string, ext: string) => join(refs, `${refId}.${ext}`),
    /** 参照画像の用途の言葉・要点・渡した印 */
    refMeta: (refId: string) => join(refs, `${refId}.json`),
    /** LLM に渡す縮小版。長辺を名前に入れる（生成された画像の縮小版と同じ形） */
    refPreview: (refId: string, longEdge: number) =>
      join(refs, `${refId}.preview-${longEdge}.webp`),
    interventions,
    /** 口出し1件 */
    intervention: (interventionId: string) => join(interventions, `${interventionId}.json`),
    llmCalls,
    llmCall: (callId: string) => join(llmCalls, `${callId}.json`),
    iterations,
    iteration: (iteration: number) => iterationFiles(join(iterations, iterationDirName(iteration))),
  };
}

function iterationFiles(dir: string) {
  const images = join(dir, 'images');
  return {
    dir,
    think: join(dir, 'think.json'),
    request: join(dir, 'request.json'),
    judge: join(dir, 'judge.json'),
    images,
    /** 生成された画像（原寸） */
    image: (index: number) => join(images, `${index}.png`),
    /** バックエンドの応答のメタデータ */
    imageMeta: (index: number) => join(images, `${index}.json`),
    /** LLM に渡す縮小版。長辺を名前に入れ、設定を変えても古い縮小版と混ざらないようにする */
    preview: (index: number, longEdge: number) => join(images, `${index}.preview-${longEdge}.webp`),
    /** この画像を LLM に渡した呼び出しの ID（渡した印） */
    sent: (index: number) => join(images, `${index}.sent.json`),
  };
}

export type JobFiles = ReturnType<typeof jobFiles>;

export type DataPaths = ReturnType<typeof dataPaths>;
