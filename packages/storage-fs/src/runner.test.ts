// ループ（core の JobRunner）を、本物のファイルの置き場所（FsJobStore）の上で回す試験。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ。M2 の受け入れ基準 :70〜:74 を見る
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BUDGET,
  JobRunner,
  InterventionRejectedError,
  THINK_PARAM_KEYS,
  type AutoJobSpec,
  type GenerationRequest,
  type GenerationResult,
  type JobState,
  type LlmCall,
  type StopConditionsChange,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';
import { dataPaths } from './paths.js';

let root: string;
let bigPng: Uint8Array;

beforeAll(async () => {
  bigPng = await sharp({ create: { width: 1024, height: 768, channels: 3, background: '#884422' } })
    .png()
    .toBuffer();
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** スタブのバックエンドが返す画像を、縮小が意味を持つ大きさにする */
class BigImageBackend extends StubBackend {
  override async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    const result = await super.generate(req, signal);
    return { ...result, images: result.images.map((image) => ({ ...image, png: bigPng.slice() })) };
  }
}

const think: Script = (_call, n) => ({
  params: {
    prompt: `girl, beach, sunset, take ${n + 1}`,
    negativePrompt: 'lowres',
    seed: -1,
    steps: 28,
    cfg: 7,
  },
  rationale: `${n + 1} 回目の案`,
});

function imageCount(call: LlmCall<unknown>): number {
  return call.messages.user.filter((part) => part.type === 'image').length;
}

/** stopAt 回目（1始まり）で「止めてよい」と言う見る役。言わせないなら undefined */
function judge(stopAt?: number): Script {
  return (call, n) => ({
    images: Array.from({ length: imageCount(call) }, (_, i) => ({
      score: Math.min(0.9, 0.3 + n * 0.1 + i * 0.01),
      issues: ['指が崩れている', '背景が暗い'],
    })),
    nextChange: 'もっと逆光にする',
    canStop: stopAt !== undefined && n + 1 >= stopAt,
  });
}

function setup(options: {
  scripts: ConstructorParameters<typeof ScriptedLlm>[0];
  backend?: StubBackend;
  now?: () => Date;
}) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm(options.scripts);
  const backend = options.backend ?? new BigImageBackend();
  let seq = 0;
  const runner = new JobRunner({
    store,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    allowed: THINK_PARAM_KEYS,
    defaults: { width: 1024, height: 768, steps: 20, cfgScale: 7, negativePrompt: '' },
    ...(options.now === undefined ? {} : { now: options.now }),
    newCallId: () => String(++seq).padStart(4, '0'),
  });
  return { store, llm, backend, runner };
}

async function submit(
  store: FsJobStore,
  conditions: AutoJobSpec['stopConditions'],
  batchSize = 2,
): Promise<AutoJobSpec> {
  const spec = await store.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ白いワンピースの少女、アニメ調',
      stopConditions: conditions,
      batchSize,
    },
    {
      status: 'queued',
      carry: { intent: '夕暮れの海辺に立つ白いワンピースの少女、アニメ調', completedIterations: 0 },
    },
    new Date(),
  );
  if (spec.kind !== 'auto') throw new Error('auto のはず');
  return spec;
}

async function stoppedState(store: FsJobStore, jobId: string) {
  const state: JobState = await store.readState(jobId);
  if (state.status !== 'stopped') throw new Error(`止まっていない: ${state.status}`);
  return state;
}

async function iterationDirs(jobId: string): Promise<string[]> {
  return (await readdir(dataPaths(root).jobFiles(jobId).iterations)).sort();
}

describe('the loop stops (:70)', () => {
  it('stops when the judge says the intent is met', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge(2) } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 10 });
    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.kind).toBe('ai');
    expect(state.carry?.completedIterations).toBe(2);
    expect(state.imagesGenerated).toBe(4);
  });

  it('stops at the iteration limit without anyone touching it', async () => {
    const { store, runner, backend } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 3 });
    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.kind).toBe('limit:iterations');
    expect(await iterationDirs(spec.jobId)).toEqual(['0001', '0002', '0003']);
    expect(backend.requests).toHaveLength(3);
  });

  it('stops at the image and time limits', async () => {
    const images = setup({ scripts: { think, judge: judge() } });
    const byImages = await submit(images.store, { aiJudgement: false, maxImages: 3 }, 2);
    images.runner.kick();
    await images.runner.idle();
    expect((await stoppedState(images.store, byImages.jobId)).reason.kind).toBe('limit:images');

    let t = Date.parse('2026-10-09T00:00:00Z');
    const timed = setup({
      scripts: { think, judge: judge() },
      now: () => new Date((t += 20_000)),
    });
    const byTime = await submit(timed.store, { aiJudgement: false, maxDurationMs: 120_000 });
    timed.runner.kick();
    await timed.runner.idle();
    expect((await stoppedState(timed.store, byTime.jobId)).reason.kind).toBe('limit:duration');
  });

  it('stops when a human stops it during generation, and interrupts the backend', async () => {
    const backend = new BigImageBackend({ generateDelayMs: 5_000 });
    const { store, runner } = setup({ scripts: { think, judge: judge() }, backend });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 10 });
    runner.kick();
    while (backend.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    await runner.stop(spec.jobId);
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.kind).toBe('human');
    expect(backend.interruptCount).toBe(1);
    const files = dataPaths(root).jobFiles(spec.jobId).iteration(1);
    await expect(stat(files.request)).rejects.toThrow();
  });

  it('stops a queued job that has not started', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 3 });
    await runner.stop(spec.jobId);
    runner.kick();
    await runner.idle();
    expect((await stoppedState(store, spec.jobId)).reason.kind).toBe('human');
    expect(await readdir(dataPaths(root).jobFiles(spec.jobId).dir)).not.toContain('iterations');
  });

  it('runs queued jobs one after another in creation order', async () => {
    const { store, runner, backend } = setup({ scripts: { think, judge: judge(1) } });
    const first = await submit(store, { aiJudgement: true, maxIterations: 5 });
    const second = await submit(store, { aiJudgement: true, maxIterations: 5 });
    runner.kick();
    await runner.idle();
    expect((await stoppedState(store, first.jobId)).reason.kind).toBe('ai');
    expect((await stoppedState(store, second.jobId)).reason.kind).toBe('ai');
    expect(backend.requests).toHaveLength(2);
  });
});

describe('the input to the LLM stays within the budget (:71)', () => {
  it('keeps every think and judge input within the same limit from iteration 1 to 30', async () => {
    const { store, runner, llm } = setup({ scripts: { think, judge: judge() } });
    await submit(store, { aiJudgement: true, maxIterations: 30 });
    runner.kick();
    await runner.idle();

    const byPurpose = (purpose: string) => llm.calls.filter((c) => c.purpose === purpose);
    for (const purpose of ['think', 'judge']) {
      const calls = byPurpose(purpose);
      expect(calls).toHaveLength(30);
      const sizes = calls.map((c) => c.messages.report.estimatedInputTokens);
      for (const call of calls) {
        expect(call.messages.report.estimatedInputTokens).toBeLessThanOrEqual(
          call.messages.report.inputTokenLimit,
        );
      }
      // 最良と直近の2区画が出そろったあとは頭打ちになる。10〜30回目は、1〜10回目の最大を、
      // 回の番号と残りの回数の桁の分しか超えない
      const early = Math.max(...sizes.slice(0, 10));
      expect(Math.max(...sizes.slice(10))).toBeLessThanOrEqual(early + 8);
    }
    // 既定の 5 秒にしない: 30 回ぶんの画像の縮小をファイルの上で実際に回すため、遅い機械では超える
  }, 30_000);
});

describe('images are passed once, and only as previews (:72)', () => {
  it('passes each generated image to the judge exactly once, shrunk to the long edge', async () => {
    const { store, runner, llm } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 }, 3);
    runner.kick();
    await runner.idle();

    const images = llm.calls.flatMap((c) =>
      c.messages.user.flatMap((p) => (p.type === 'image' ? [p] : [])),
    );
    expect(images).toHaveLength(15);
    expect(new Set(images.map((i) => i.key)).size).toBe(15);
    for (const image of images) {
      const meta = await sharp(image.data).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
        DEFAULT_BUDGET.imageLongEdge,
      );
      expect(meta.format).toBe('webp');
    }
    expect(
      llm.calls
        .filter((c) => c.purpose === 'think')
        .every((c) => c.messages.user.every((p) => p.type === 'text')),
    ).toBe(true);
    const sent = await readdir(dataPaths(root).jobFiles(spec.jobId).iteration(5).images);
    expect(sent.filter((name) => name.endsWith('.sent.json'))).toHaveLength(3);
  });
});

describe('a broken structured output stops the job with the reason (:73)', () => {
  it('stops as an error and keeps the reason and the call record', async () => {
    const { store, runner } = setup({
      scripts: { think: () => ({ params: { steps: 9999 }, rationale: '' }), judge: judge() },
    });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 });
    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.kind).toBe('error');
    expect(state.reason.detail).toMatch(/^考える段: 構造化出力が/);
    const records = await store.listLlmCalls(spec.jobId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ iteration: 1, purpose: 'think', outcome: { ok: false } });
    expect(records[0]?.attempts[0]?.validationError).toBeDefined();
  });

  it('stops as an error when the backend fails, naming the stage', async () => {
    const backend = new BigImageBackend();
    backend.setUnreachable(true);
    const { store, runner } = setup({ scripts: { think, judge: judge() }, backend });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 });
    runner.kick();
    await runner.idle();
    expect((await stoppedState(store, spec.jobId)).reason.detail).toMatch(/^生成の段: /);
  });
});

describe('a job resumes where it stopped (:74)', () => {
  it('resumes at the judge stage without thinking or generating again', async () => {
    // 1つ目のプロセス: 2回目の「見る」の途中で返らなくなる（そこで落ちたものとみなす）
    const first = setup({
      scripts: {
        think,
        judge: (call, n) => (n === 1 ? new Promise(() => undefined) : judge()(call, n)),
      },
    });
    const spec = await submit(first.store, { aiJudgement: true, maxIterations: 3 });
    first.runner.kick();
    const requestOf2 = dataPaths(root).jobFiles(spec.jobId).iteration(2).request;
    while (first.llm.calls.filter((c) => c.purpose === 'judge').length < 2) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await stat(requestOf2);

    // 2つ目のプロセス: 同じデータディレクトリから起動し直す
    const second = setup({ scripts: { think: (c, n) => think(c, n + 2), judge: judge() } });
    second.runner.kick();
    await second.runner.idle();

    const state = await stoppedState(second.store, spec.jobId);
    expect(state.reason.kind).toBe('limit:iterations');
    expect(state.carry?.completedIterations).toBe(3);
    // 2回目は「見る」からやり直し、3回目だけを新しく考えて生成した
    expect(second.llm.calls.map((c) => c.purpose)).toEqual(['judge', 'think', 'judge']);
    expect(second.backend.requests).toHaveLength(1);
    expect(first.backend.requests).toHaveLength(2);
  });
});

describe('a job resumes after the process is killed (:74)', () => {
  const child = fileURLToPath(new URL('./test-fixtures/runner-child.mjs', import.meta.url));

  it('continues from the next stage after SIGKILL during generation', async () => {
    const { store, runner, llm, backend } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 3 }, 1);
    const thinkOf2 = dataPaths(root).jobFiles(spec.jobId).iteration(2).think;

    const proc = spawn(process.execPath, [child, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      proc.once('exit', (_code, signal) => resolve(signal)),
    );
    // 2回目を考え終えた（＝2回目の生成の途中）ところで殺す
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`child exited early: ${stderr}`);
      if (
        await stat(thinkOf2).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    proc.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    await expect(stat(dataPaths(root).jobFiles(spec.jobId).iteration(2).request)).rejects.toThrow();

    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.kind).toBe('limit:iterations');
    expect(state.carry?.completedIterations).toBe(3);
    // 2回目は考え直さずに生成からやり直し、3回目だけを新しく考えた
    expect(llm.calls.map((c) => c.purpose)).toEqual(['judge', 'think', 'judge']);
    expect(backend.requests).toHaveLength(2);
    const thinkRecords = (await store.listLlmCalls(spec.jobId)).filter(
      (r) => r.purpose === 'think',
    );
    // 子と親で callId の形が違い名前の順が混ざるので、回の番号の集まりで見る
    expect(thinkRecords.map((r) => r.iteration).sort()).toEqual([1, 2, 3]);
  }, 20_000);
});

/** n 回目（1始まり）の生成の途中で、渡した処理を待つバックエンド */
class BackendWithHook extends BigImageBackend {
  private generated = 0;

  constructor(private readonly during: (n: number) => Promise<void>) {
    super();
  }

  override async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    this.generated += 1;
    await this.during(this.generated);
    return super.generate(req, signal);
  }
}

/** n 回目の生成の途中で止める条件を変えるジョブを、待ち行列に入れる */
async function submitChangedDuring(
  n: number,
  conditions: AutoJobSpec['stopConditions'],
  change: StopConditionsChange,
) {
  const job = { jobId: '' };
  const backend = new BackendWithHook(async (k) => {
    if (k === n) await set.runner.changeStopConditions(job.jobId, change);
  });
  const set = setup({ scripts: { think, judge: judge() }, backend });
  const spec = await submit(set.store, conditions);
  job.jobId = spec.jobId;
  return { ...set, spec };
}

describe('the stop conditions can be changed while the job runs (M3:101)', () => {
  it('stops at the lowered iteration limit, finishing the iteration that was being generated', async () => {
    const { store, runner, spec } = await submitChangedDuring(
      2,
      { aiJudgement: false, maxIterations: 5 },
      { maxIterations: 2 },
    );
    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason).toEqual({ kind: 'limit:iterations', detail: '2 回に達した' });
    expect(await iterationDirs(spec.jobId)).toEqual(['0001', '0002']);
    expect(await store.readStage(spec.jobId, 2, 'judge')).toBeDefined();
  });

  it('keeps going past the original limit once it is raised', async () => {
    const { store, runner, spec } = await submitChangedDuring(
      1,
      { aiJudgement: false, maxIterations: 1 },
      { maxIterations: 3 },
    );
    runner.kick();
    await runner.idle();

    expect((await stoppedState(store, spec.jobId)).carry?.completedIterations).toBe(3);
  });

  it('applies a change made while the job waits in the queue from its first boundary', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge(1) } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 });
    expect(
      await runner.changeStopConditions(spec.jobId, { aiJudgement: false, maxIterations: 2 }),
    ).toEqual({ aiJudgement: false, maxIterations: 2 });
    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.kind).toBe('limit:iterations');
    expect(state.carry?.completedIterations).toBe(2);
  });

  it('leaves job.json as it was submitted', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 });
    await runner.changeStopConditions(spec.jobId, { maxIterations: 1, maxImages: 10 });
    runner.kick();
    await runner.idle();

    expect(await store.readJob(spec.jobId)).toEqual(spec);
    expect(await store.listInterventions(spec.jobId)).toEqual([
      expect.objectContaining({
        kind: 'stopConditions',
        stopConditions: { maxIterations: 1, maxImages: 10 },
      }),
    ]);
  });

  it('is not moved by a human instruction, which only goes to the think', async () => {
    const { store, runner } = setup({ scripts: { think: thinkIntegrating, judge: judge() } });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 2 });
    await store.addIntervention(
      spec.jobId,
      { kind: 'instruction', text: 'あと10回は回して' },
      new Date(),
    );
    runner.kick();
    await runner.idle();

    expect((await stoppedState(store, spec.jobId)).carry?.completedIterations).toBe(2);
  });

  it('refuses to change a job that has already stopped', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 1 });
    runner.kick();
    await runner.idle();

    await expect(runner.changeStopConditions(spec.jobId, { maxIterations: 3 })).rejects.toThrow(
      InterventionRejectedError,
    );
    await expect(runner.addInstruction(spec.jobId, '逆光にして')).rejects.toThrow(
      InterventionRejectedError,
    );
    expect(await store.listInterventions(spec.jobId)).toEqual([]);
  });

  it('refuses a change that would leave the job with no way to stop, and writes nothing', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 5 });

    await expect(runner.changeStopConditions(spec.jobId, { maxIterations: null })).rejects.toThrow(
      /止まらなくなる/,
    );
    expect(await store.listInterventions(spec.jobId)).toEqual([]);
    expect(
      await runner.changeStopConditions(spec.jobId, { maxIterations: null, maxImages: 8 }),
    ).toEqual({ aiJudgement: false, maxImages: 8 });
  });
});

const INTEGRATED = '逆光で夕暮れの海辺に立つ白いワンピースの少女、アニメ調';

/** 求められたときは統合した要点も返す考える役（求められなければスキーマが落とす） */
const thinkIntegrating: Script = (call, n) => ({
  ...(think(call, n) as object),
  intent: INTEGRATED,
});

function recordedText(record: { input: { user: { type: string; text?: string }[] } }): string {
  return record.input.user.map((part) => part.text ?? '').join('\n');
}

describe('a human instruction reaches the next think without stopping the image (M3:99)', () => {
  it('lets the image being generated finish, and takes the instruction into the next think', async () => {
    const job = { jobId: '' };
    const backend = new BackendWithHook(async (n) => {
      if (n === 1) {
        await set.store.addIntervention(
          job.jobId,
          { kind: 'instruction', text: '逆光にして' },
          new Date(),
        );
      }
    });
    const set = setup({ scripts: { think: thinkIntegrating, judge: judge() }, backend });
    const spec = await submit(set.store, { aiJudgement: false, maxIterations: 3 });
    job.jobId = spec.jobId;
    set.runner.kick();
    await set.runner.idle();

    expect(backend.interruptCount).toBe(0);
    expect(backend.requests).toHaveLength(3);

    const thinks = (await set.store.listLlmCalls(spec.jobId)).filter((r) => r.role === 'think');
    expect(thinks.map((r) => r.iteration)).toEqual([1, 2, 3]);
    expect(recordedText(thinks[0]!)).not.toContain('逆光にして');
    expect(recordedText(thinks[1]!).split('人間の指示:')[1]).toContain('逆光にして');
    expect(recordedText(thinks[2]!)).not.toContain('人間の指示');
    expect(recordedText(thinks[2]!)).toContain(INTEGRATED);

    expect(await set.store.listInterventions(spec.jobId)).toEqual([
      expect.objectContaining({ kind: 'instruction', text: '逆光にして', appliedInIteration: 2 }),
    ]);
    expect((await stoppedState(set.store, spec.jobId)).carry?.intent).toBe(INTEGRATED);
  });

  it('takes an instruction in again when the think that claimed it never finished', async () => {
    const { store, runner, llm } = setup({ scripts: { think: thinkIntegrating, judge: judge() } });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 1 });
    const said = await store.addIntervention(
      spec.jobId,
      { kind: 'instruction', text: '逆光にして' },
      new Date(),
    );
    // 1回目の「考える」が取り込んだ回を書き、think.json を置く前に落ちた跡
    await store.markInterventionApplied(spec.jobId, said.interventionId, 1);
    runner.kick();
    await runner.idle();

    const firstThink = llm.calls.find((c) => c.purpose === 'think');
    const text = firstThink?.messages.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(text).toContain('逆光にして');
    expect((await stoppedState(store, spec.jobId)).carry?.intent).toBe(INTEGRATED);
  });
});

const GIST = '逆光の海辺、白いワンピースの裾が風になびく構図';
const refGist: Script = () => ({ gist: GIST });

/** 縮小が意味を持つ大きさの参照画像（原寸） */
async function bigReference(): Promise<Uint8Array> {
  return sharp({ create: { width: 2000, height: 1200, channels: 3, background: '#2266aa' } })
    .jpeg()
    .toBuffer();
}

function textOf(call: LlmCall<unknown>): string {
  return call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

function imageKeysOf(call: LlmCall<unknown>): string[] {
  return call.messages.user.flatMap((part) => (part.type === 'image' ? [part.key] : []));
}

describe('a reference image goes to the LLM once, shrunk, then travels as its gist (M3:102)', () => {
  it('shows the reference once to the judge role, and only the gist text afterwards', async () => {
    const { store, runner, llm } = setup({
      scripts: { think, judge: judge(), 'ref-gist': refGist },
    });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 3 });
    const reference = await store.addReference(
      spec.jobId,
      { data: await bigReference(), mediaType: 'image/jpeg', note: 'この構図で' },
      new Date(),
    );
    runner.kick();
    await runner.idle();

    const refKey = `jobs/${spec.jobId}/refs/${reference.refId}`;
    const carrying = llm.calls.filter((call) => imageKeysOf(call).includes(refKey));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.purpose).toBe('ref-gist');
    expect(carrying[0]!.role).toBe('judge');

    const shown = carrying[0]!.messages.user.find((part) => part.type === 'image');
    const { width = 0, height = 0 } = await sharp(
      shown?.type === 'image' ? shown.data : undefined,
    ).metadata();
    expect(Math.max(width, height)).toBeLessThanOrEqual(DEFAULT_BUDGET.imageLongEdge);

    const after = llm.calls.slice(llm.calls.indexOf(carrying[0]!) + 1);
    expect(after.map((call) => call.purpose)).toEqual([
      'think',
      'judge',
      'think',
      'judge',
      'think',
      'judge',
    ]);
    for (const call of after) {
      expect(imageKeysOf(call)).not.toContain(refKey);
      expect(textOf(call)).toContain(GIST);
    }

    const [stored] = await store.listReferences(spec.jobId);
    expect(stored).toMatchObject({ gist: GIST, sentInCall: expect.any(String) });
    expect((await stoppedState(store, spec.jobId)).carry?.references).toEqual([
      { refId: reference.refId, gist: GIST },
    ]);
  });

  it('turns a reference that arrives mid-iteration into its gist at the next boundary', async () => {
    const job = { jobId: '' };
    const backend = new BackendWithHook(async (n) => {
      if (n === 1) {
        await set.store.addReference(
          job.jobId,
          { data: await bigReference(), mediaType: 'image/jpeg' },
          new Date(),
        );
      }
    });
    const set = setup({ scripts: { think, judge: judge(), 'ref-gist': refGist }, backend });
    const spec = await submit(set.store, { aiJudgement: false, maxIterations: 2 });
    job.jobId = spec.jobId;
    set.runner.kick();
    await set.runner.idle();

    expect(set.llm.calls.map((call) => call.purpose)).toEqual([
      'think',
      'judge',
      'ref-gist',
      'think',
      'judge',
    ]);
    const [think1, judge1, , think2, judge2] = set.llm.calls;
    expect(textOf(think1!)).not.toContain(GIST);
    expect(textOf(judge1!)).not.toContain(GIST);
    expect(textOf(think2!)).toContain(GIST);
    expect(textOf(judge2!)).toContain(GIST);
  });
});
