// ループ（core の JobRunner）を、本物のファイルの置き場所（FsJobStore）の上で回す試験。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ。M2 の受け入れ基準 :70〜:74 を見る
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BackendError,
  basicPermissions,
  createCarry,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  generationRequestSchema,
  JobRunner,
  InterventionRejectedError,
  resolveBudgets,
  type AutoJobSpec,
  type BudgetOverrides,
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
  return (call, n) => {
    const canStop = stopAt !== undefined && n + 1 >= stopAt;
    return {
      images: Array.from({ length: imageCount(call) }, (_, i) => ({
        // 止めてよいと言う回は、意図どおりと言える点数にする（低いまま止めてよいとした出力は受け付けられない）
        score: canStop ? 0.8 + i * 0.01 : Math.min(0.9, 0.3 + n * 0.1 + i * 0.01),
        issues: ['指が崩れている', '背景が暗い'],
      })),
      nextChange: 'もっと逆光にする',
      canStop,
    };
  };
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
    permissions: basicPermissions({ width: 1024, height: 768 }),
    ...(options.now === undefined ? {} : { now: options.now }),
    newCallId: () => String(++seq).padStart(4, '0'),
  });
  return { store, llm, backend, runner };
}

async function submit(
  store: FsJobStore,
  conditions: AutoJobSpec['stopConditions'],
  batchSize = 2,
  {
    request = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調',
    at = new Date(),
    budgets,
  }: { request?: string; at?: Date; budgets?: BudgetOverrides } = {},
): Promise<AutoJobSpec> {
  const resolved = budgets === undefined ? undefined : resolveBudgets(budgets);
  const spec = await store.createJob(
    {
      kind: 'auto',
      request,
      stopConditions: conditions,
      batchSize,
      ...(resolved === undefined ? {} : { budgets: resolved }),
    },
    {
      status: 'queued',
      // 投入と同じく、そのジョブの予算で依頼を切り詰めた要約から始める
      carry: createCarry(request, resolved ?? DEFAULT_BUDGETS).carry,
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
        request: generationRequestSchema.parse({
          prompt: 'a cat',
          negativePrompt: '',
          loras: [],
          steps: 4,
          cfgScale: 7,
          width: 64,
          height: 64,
          batchSize: 1,
        }),
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

describe('a job runs with the budgets written in its job.json (Issue #63)', () => {
  it('shrinks images to the long edge of the job and places previews of that size only', async () => {
    const { store, runner, llm } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 2 }, 2, {
      budgets: { imageLongEdge: 256 },
    });
    runner.kick();
    await runner.idle();

    const images = llm.calls.flatMap((c) =>
      c.messages.user.flatMap((p) => (p.type === 'image' ? [p] : [])),
    );
    expect(images).toHaveLength(4);
    for (const image of images) {
      const meta = await sharp(image.data).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
    }
    const names = await readdir(dataPaths(root).jobFiles(spec.jobId).iteration(1).images);
    expect(names).toContain('0.preview-256.webp');
    expect(names.some((name) => name.includes('preview-512'))).toBe(false);
  });

  it('keeps every think input within the limit of the job when its text budgets are small', async () => {
    const request = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調。'.repeat(40);
    const small = setup({ scripts: { think, judge: judge() } });
    await submit(small.store, { aiJudgement: false, maxIterations: 5 }, 2, {
      request,
      budgets: { text: { intent: 40, prompt: 60, negativePrompt: 30, rationale: 20 } },
    });
    small.runner.kick();
    await small.runner.idle();
    const roomy = setup({ scripts: { think, judge: judge() } });
    await submit(roomy.store, { aiJudgement: false, maxIterations: 5 }, 2, { request });
    roomy.runner.kick();
    await roomy.runner.idle();

    const thinkCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.purpose === 'think');
    const sizesOf = (llm: ScriptedLlm) =>
      thinkCalls(llm).map((c) => c.messages.report.estimatedInputTokens);
    expect(sizesOf(small.llm)).toHaveLength(5);
    for (const call of thinkCalls(small.llm)) {
      expect(call.messages.report.estimatedInputTokens).toBeLessThanOrEqual(
        call.messages.report.inputTokenLimit,
      );
    }
    expect(Math.max(...sizesOf(small.llm))).toBeLessThan(Math.min(...sizesOf(roomy.llm)));
    // 既定の 5 秒にしない: 2 つのジョブぶんの画像の縮小をファイルの上で実際に回すため、遅い機械では超える
  }, 30_000);

  it('runs a job without budgets on the defaults of the runner', async () => {
    const { store, runner, llm } = setup({ scripts: { think, judge: judge() } });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 1 });
    expect(spec.budgets).toBeUndefined();
    runner.kick();
    await runner.idle();

    const images = llm.calls.flatMap((c) =>
      c.messages.user.flatMap((p) => (p.type === 'image' ? [p] : [])),
    );
    const meta = await sharp(images[0]!.data).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(DEFAULT_BUDGET.imageLongEdge);
    const names = await readdir(dataPaths(root).jobFiles(spec.jobId).iteration(1).images);
    expect(names).toContain(`0.preview-${DEFAULT_BUDGET.imageLongEdge}.webp`);
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
    backend.failNextGenerate(new BackendError('failed', 'Forge が失敗を返した'));
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

  // 生成した枚数は、見る役まで済んだかを問わず、生成した画像の数（止める条件の「生成枚数」と同じ意味）。
  // 見る役が失敗した回の画像も置かれていて、画面に並び、選ぶこともできるため
  it('counts the images of the iteration whose judge failed as generated', async () => {
    const judgeFailsSecond: Script = (call, n) =>
      n === 0 ? judge()(call, n) : { images: 'broken', canStop: 'no' };
    const { store, runner } = setup({ scripts: { think, judge: judgeFailsSecond } });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 }, 2);
    runner.kick();
    await runner.idle();

    const state = await stoppedState(store, spec.jobId);
    expect(state.reason.detail).toMatch(/^見る段: /);
    expect(state.carry?.completedIterations).toBe(1);
    expect(state.imagesGenerated).toBe(4);
  });

  it('does not count images that were never placed', async () => {
    const thinkFails = setup({
      scripts: { think: () => ({ params: { steps: 9999 }, rationale: '' }), judge: judge() },
    });
    const notThought = await submit(thinkFails.store, { aiJudgement: true, maxIterations: 5 }, 2);
    thinkFails.runner.kick();
    await thinkFails.runner.idle();
    expect((await stoppedState(thinkFails.store, notThought.jobId)).imagesGenerated).toBe(0);

    const backend = new BigImageBackend({ generateDelayMs: 5_000 });
    const stoppedMidGeneration = setup({ scripts: { think, judge: judge() }, backend });
    const interrupted = await submit(
      stoppedMidGeneration.store,
      { aiJudgement: true, maxIterations: 5 },
      2,
    );
    stoppedMidGeneration.runner.kick();
    while (backend.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    await stoppedMidGeneration.runner.stop(interrupted.jobId);
    await stoppedMidGeneration.runner.idle();
    const human = await stoppedState(stoppedMidGeneration.store, interrupted.jobId);
    expect(human.reason.kind).toBe('human');
    expect(human.imagesGenerated).toBe(0);
  });

  it('stops before thinking when the backend is down at the start of the job', async () => {
    const backend = new BigImageBackend();
    backend.setUnreachable(true);
    const { store, llm, runner } = setup({ scripts: { think, judge: judge() }, backend });
    const spec = await submit(store, { aiJudgement: true, maxIterations: 5 });
    runner.kick();
    await runner.idle();

    const { reason } = await stoppedState(store, spec.jobId);
    expect(reason).toMatchObject({ kind: 'error', backendErrorKind: 'unreachable' });
    expect(reason.detail).toMatch(/^バックエンドの能力と候補を取る段: /);
    expect(llm.calls).toEqual([]);
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

  it('refuses every kind of intervention on a manual job, with the reason manual', async () => {
    const { store, runner } = setup({ scripts: { think, judge: judge() } });
    const manual = await store.createJob(
      {
        kind: 'manual',
        request: generationRequestSchema.parse({
          prompt: 'a cat',
          negativePrompt: '',
          loras: [],
          steps: 4,
          cfgScale: 7,
          width: 64,
          height: 64,
          batchSize: 1,
        }),
      },
      { status: 'queued' },
      new Date(),
    );
    const rejected = { name: 'InterventionRejectedError', reason: 'manual' };

    await expect(runner.addInstruction(manual.jobId, '逆光にして')).rejects.toMatchObject(rejected);
    await expect(
      runner.changeStopConditions(manual.jobId, { maxIterations: 3 }),
    ).rejects.toMatchObject(rejected);
    await expect(
      runner.addReference(manual.jobId, { data: new Uint8Array([1]), mediaType: 'image/png' }),
    ).rejects.toMatchObject(rejected);
    expect(await store.listInterventions(manual.jobId)).toEqual([]);
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

  it('stops the job as an error naming the reference gist when the gist cannot be made', async () => {
    const { store, runner } = setup({
      scripts: { think, judge: judge(), 'ref-gist': () => ({ gist: '' }) },
    });
    const spec = await submit(store, { aiJudgement: false, maxIterations: 3 });
    await store.addReference(
      spec.jobId,
      { data: await bigReference(), mediaType: 'image/jpeg' },
      new Date(),
    );
    runner.kick();
    await runner.idle();

    const { reason, carry } = await stoppedState(store, spec.jobId);
    expect(reason.kind).toBe('error');
    expect(reason.detail).toMatch(/^参照画像の要点: /);
    expect(carry?.completedIterations).toBe(0);
  });

  /** 要点を残したあと、渡した印を付ける所で落ちたものとみなす（返らなくなる） */
  class CrashAtMarkSentStore extends FsJobStore {
    reached = false;
    override markSent(): Promise<void> {
      this.reached = true;
      return new Promise(() => undefined);
    }
  }

  it('keeps the gist before marking the reference as sent, so a crash in between neither loses it nor sends the image twice', async () => {
    const first = setup({
      scripts: { think, judge: judge(), 'ref-gist': refGist },
      store: new CrashAtMarkSentStore(root),
    });
    const spec = await submit(first.store, { aiJudgement: false, maxIterations: 1 });
    await first.store.addReference(
      spec.jobId,
      { data: await bigReference(), mediaType: 'image/jpeg' },
      new Date(),
    );
    first.runner.kick();
    while (!(first.store as CrashAtMarkSentStore).reached) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const second = setup({ scripts: { think, judge: judge(), 'ref-gist': refGist } });
    second.runner.kick();
    await second.runner.idle();

    expect(first.llm.calls.filter((c) => c.purpose === 'ref-gist')).toHaveLength(1);
    expect(second.llm.calls.map((c) => c.purpose)).toEqual(['think', 'judge']);
    expect(textOf(second.llm.calls[0]!)).toContain(GIST);
    const { reason, carry } = await stoppedState(second.store, spec.jobId);
    expect(reason.kind).toBe('limit:iterations');
    expect(carry?.references).toEqual([expect.objectContaining({ gist: GIST })]);
  });
});

describe('plan.json records what was left out of the AI choices', () => {
  async function runOne(
    permissions: NonNullable<AutoJobSpec['permissions']>,
    backend: StubBackend,
  ): Promise<{ store: FsJobStore; jobId: string }> {
    const { store, runner } = setup({ scripts: { think, judge: judge() }, backend });
    const request = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調';
    const spec = await store.createJob(
      {
        kind: 'auto',
        request,
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
        permissions,
      },
      { status: 'queued', carry: { intent: request, completedIterations: 0 } },
      new Date(),
    );
    runner.kick();
    await runner.idle();
    return { store, jobId: spec.jobId };
  }

  it('keeps loras that were left to the AI but had no candidate to show', async () => {
    const { store, jobId } = await runOne(
      { loras: { mode: 'auto' } },
      new StubBackend({ candidates: { lora: [] } }),
    );

    expect(await store.readStage(jobId, 1, 'plan')).toEqual({
      excluded: [{ param: 'loras', wanted: 'auto', reason: { kind: 'no-candidates-shown' } }],
    });
  });

  it('keeps inpaint that was left to the AI when there is no mask, and still goes on', async () => {
    const { store, jobId } = await runOne({ inpaint: { mode: 'auto' } }, new StubBackend());

    expect(await store.readStage(jobId, 1, 'plan')).toEqual({
      excluded: [{ param: 'inpaint', wanted: 'auto', reason: { kind: 'no-mask' } }],
    });
    expect((await stoppedState(store, jobId)).carry?.completedIterations).toBe(1);
  });

  it.each([
    ['auto', { mode: 'auto' }],
    // 固定の値は、要求の controlnet の欄と同じ形（ユニットの配列）にする
    ['fixed', { mode: 'fixed', value: [{ image: 'refs/r1.png', model: 'canny' }] }],
  ] as const)(
    'keeps controlnet the backend cannot do, with what the human wanted (%s)',
    async (wanted, permission) => {
      const { store, jobId } = await runOne(
        { controlnet: permission },
        new StubBackend({
          capabilities: {
            unavailable: [{ feature: 'controlnet', reason: 'ControlNet の拡張が無い' }],
          },
        }),
      );

      expect(await store.readStage(jobId, 1, 'plan')).toEqual({
        excluded: [
          {
            param: 'controlnet',
            wanted,
            reason: { kind: 'backend', detail: 'ControlNet の拡張が無い' },
          },
        ],
      });
    },
  );

  it('does not list what the human turned off, even if the backend cannot do it', async () => {
    const { store, jobId } = await runOne(
      { loras: { mode: 'off' }, controlnet: { mode: 'off' }, inpaint: { mode: 'off' } },
      new StubBackend({
        candidates: { lora: [] },
        capabilities: { unavailable: [{ feature: 'controlnet', reason: '拡張が無い' }] },
      }),
    );

    expect(await store.readStage(jobId, 1, 'plan')).toEqual({ excluded: [] });
  });

  it('does not write it again for an iteration whose think.json already exists', async () => {
    let hung: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (hung = resolve));
    class CrashBeforeAdvanceStore extends FsJobStore {
      override writeState(jobId: string, state: JobState): Promise<void> {
        if (state.status === 'running' && state.carry?.completedIterations === 1) {
          hung();
          return new Promise(() => undefined);
        }
        return super.writeState(jobId, state);
      }
    }
    const first = setup({
      scripts: { think, judge: judge() },
      store: new CrashBeforeAdvanceStore(root),
      backend: new StubBackend({ candidates: { lora: [] } }),
    });
    const spec = await first.store.createJob(
      {
        kind: 'auto',
        request: 'r',
        stopConditions: { aiJudgement: false, maxIterations: 2 },
        batchSize: 1,
        permissions: { loras: { mode: 'auto' } },
      },
      { status: 'queued', carry: { intent: 'r', completedIterations: 0 } },
      new Date(),
    );
    first.runner.kick();
    await reached;
    const planFile = dataPaths(root).jobFiles(spec.jobId).iteration(1).plan;
    const before = {
      text: await readFile(planFile, 'utf8'),
      mtimeMs: (await stat(planFile)).mtimeMs,
    };
    await new Promise((r) => setTimeout(r, 20));

    // 再開では lora の候補が見える: 書き直せば中身が変わる
    const second = setup({
      scripts: { think: (c, n) => think(c, n + 1), judge: judge() },
    });
    second.runner.kick();
    await second.runner.idle();

    expect(await readFile(planFile, 'utf8')).toBe(before.text);
    expect((await stat(planFile)).mtimeMs).toBe(before.mtimeMs);
    expect(await second.store.readStage(spec.jobId, 2, 'plan')).toEqual({ excluded: [] });
  });
});
