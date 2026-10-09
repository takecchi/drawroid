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
  THINK_PARAM_KEYS,
  type AutoJobSpec,
  type GenerationRequest,
  type GenerationResult,
  type JobState,
  type LlmCall,
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
    seed: 1234 + n,
    steps: 28,
    cfgScale: 7,
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
  store?: FsJobStore;
}) {
  const store = options.store ?? new FsJobStore(root);
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
  { request = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調', at = new Date() } = {},
): Promise<AutoJobSpec> {
  const spec = await store.createJob(
    {
      kind: 'auto',
      request,
      stopConditions: conditions,
      batchSize,
    },
    {
      status: 'queued',
      carry: { intent: request, completedIterations: 0 },
    },
    at,
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

describe('the loop picks which job to run', () => {
  const textOf = (call: LlmCall<unknown>) =>
    call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

  it('resumes a running job (one that was running before a crash) before an older queued job', async () => {
    const { store, runner, llm } = setup({ scripts: { think, judge: judge(1) } });
    const queued = await submit(store, { aiJudgement: true, maxIterations: 5 }, 2, {
      request: '古い待ちのジョブ',
      at: new Date('2026-10-09T00:00:00Z'),
    });
    const running = await submit(store, { aiJudgement: true, maxIterations: 5 }, 2, {
      request: '落ちる前に走っていたジョブ',
      at: new Date('2026-10-09T00:00:10Z'),
    });
    await store.writeState(running.jobId, {
      status: 'running',
      carry: { intent: running.request, completedIterations: 0 },
      startedAt: '2026-10-09T00:00:20Z',
      imagesGenerated: 0,
    });
    runner.kick();
    await runner.idle();

    expect(textOf(llm.calls[0] as LlmCall<unknown>)).toContain(running.request);
    expect((await stoppedState(store, running.jobId)).reason.kind).toBe('ai');
    expect((await stoppedState(store, queued.jobId)).reason.kind).toBe('ai');
  });

  it('leaves a manual job in the queue alone and goes idle after running the auto job', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge(1) } });
    const manual = await store.createJob(
      {
        kind: 'manual',
        request: {
          prompt: 'a cat',
          negativePrompt: '',
          loras: [],
          steps: 4,
          cfgScale: 7,
          width: 64,
          height: 64,
          batchSize: 1,
        },
      },
      { status: 'queued' },
      new Date('2026-10-09T00:00:00Z'),
    );
    const auto = await submit(store, { aiJudgement: true, maxIterations: 5 }, 2, {
      at: new Date('2026-10-09T00:00:10Z'),
    });
    runner.kick();
    const settled = await Promise.race([
      runner.idle().then(() => 'idle'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 3_000)),
    ]);

    expect(settled).toBe('idle');
    expect((await stoppedState(store, auto.jobId)).reason.kind).toBe('ai');
    expect(await store.readState(manual.jobId)).toEqual({ status: 'queued' });
  }, 10_000);

  it('tells the thinking role how many iterations are left, counting the one about to run', async () => {
    const { store, runner, llm } = setup({ scripts: { think, judge: judge() } });
    await submit(store, { aiJudgement: true, maxIterations: 3 });
    runner.kick();
    await runner.idle();

    const thinks = llm.calls.filter((c) => c.purpose === 'think');
    expect(thinks.map(textOf)).toEqual([
      expect.stringContaining('（残り 3 回）'),
      expect.stringContaining('（残り 2 回）'),
      expect.stringContaining('（残り 1 回）'),
    ]);
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

  it('keeps the kind of the backend error in the stop reason', async () => {
    const backend = new BigImageBackend();
    backend.setUnreachable(true);
    const { store, runner } = setup({ scripts: { think, judge: judge() }, backend });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 });
    runner.kick();
    await runner.idle();
    expect((await stoppedState(store, spec.jobId)).reason.backendErrorKind).toBe('unreachable');
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

describe('a job resumes after a crash between the judge output and state.json (:74)', () => {
  /** 回の「見る」の出力を置いたあと、state.json の回を進める書き込みで落ちたものとみなす */
  class CrashBeforeAdvanceStore extends FsJobStore {
    override writeState(jobId: string, state: JobState): Promise<void> {
      if (state.status === 'running' && state.carry?.completedIterations === 1) {
        return new Promise(() => undefined);
      }
      return super.writeState(jobId, state);
    }
  }

  it('goes on to the next iteration without judging the finished one again', async () => {
    const first = setup({
      scripts: { think, judge: judge() },
      store: new CrashBeforeAdvanceStore(root),
    });
    const spec = await submit(first.store, { aiJudgement: false, maxIterations: 2 });
    first.runner.kick();
    while ((await first.store.readStage(spec.jobId, 1, 'judge')) === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const second = setup({ scripts: { think: (c, n) => think(c, n + 1), judge: judge() } });
    second.runner.kick();
    await second.runner.idle();

    const state = await stoppedState(second.store, spec.jobId);
    expect(state.reason.kind).toBe('limit:iterations');
    expect(state.carry?.completedIterations).toBe(2);
    expect(second.llm.calls.map((c) => c.purpose)).toEqual(['think', 'judge']);
    const sent = await readdir(dataPaths(root).jobFiles(spec.jobId).iteration(1).images);
    expect(sent.filter((name) => name.endsWith('.sent.json'))).toHaveLength(2);
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
