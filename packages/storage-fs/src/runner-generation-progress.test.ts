// 生成の進み具合の口（GenerationProgressPort）を、ループ（core の JobRunner）が generate の前後で呼ぶことを見る試験。
// 置き場所は本物のファイル、LLM は台本どおりのスタブ、バックエンドは generate を試験の合図まで返さないスタブ
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackendError,
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type GenerationImages,
  type GenerationProgressPort,
  type GenerationRequest,
  type GenerationResult,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-progress-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

/** generate が、試験が release() するまで返らないバックエンド。progress を持つ */
class GatedBackend extends StubBackend {
  readonly log: string[];
  private release: (fail: boolean) => void = () => undefined;
  private entered: () => void = () => undefined;
  readonly inGenerate = new Promise<void>((resolve) => (this.entered = resolve));

  constructor(log: string[]) {
    super();
    this.log = log;
  }

  async progress(): Promise<undefined> {
    return undefined;
  }

  open(fail = false): void {
    this.release(fail);
  }

  override async generate(
    req: GenerationRequest,
    signal: AbortSignal,
    inputs?: GenerationImages,
  ): Promise<GenerationResult> {
    this.log.push('generate:begin');
    this.entered();
    const fail = await new Promise<boolean>((resolve) => (this.release = resolve));
    this.log.push('generate:end');
    if (fail) throw new BackendError('failed', '生成に失敗');
    return super.generate(req, signal, inputs);
  }
}

function fakePort(log: string[]) {
  const starts: Array<{ jobId: string; conversationId: string | undefined; iteration: number }> =
    [];
  const port: GenerationProgressPort = {
    start: async ({ jobId, conversationId, iteration }) => {
      starts.push({ jobId, conversationId, iteration });
      log.push('start');
      return {
        stop: async () => {
          log.push('stop');
        },
      };
    },
  };
  return { port, starts };
}

async function run(options: {
  backend: StubBackend;
  generationProgress?: GenerationProgressPort;
  conversationId?: string;
  settle?: () => void | Promise<void>;
}) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm({ think, judge });
  const runner = new JobRunner({
    store,
    llm,
    backend: options.backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
    ...(options.generationProgress !== undefined && {
      generationProgress: options.generationProgress,
    }),
  });
  const spec = await store.createJob(
    {
      kind: 'auto',
      request: '海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations: 1 },
      batchSize: 1,
      ...(options.conversationId !== undefined && {
        conversationId: options.conversationId,
        turn: 1,
      }),
    },
    { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
    new Date(),
  );
  runner.kick();
  await options.settle?.();
  await runner.idle();
  return { store, llm, spec };
}

describe('the runner reports generation progress around generate', () => {
  it('starts before generate, and stops only after generate returns', async () => {
    const log: string[] = [];
    const backend = new GatedBackend(log);
    const { port, starts } = fakePort(log);
    const { spec } = await run({
      backend,
      generationProgress: port,
      conversationId: 'conv-1',
      settle: async () => {
        await backend.inGenerate;
        // generate を待っている間は、start されていて stop されていない
        expect(log).toEqual(['start', 'generate:begin']);
        backend.open();
      },
    });
    expect(log).toEqual(['start', 'generate:begin', 'generate:end', 'stop']);
    expect(starts).toEqual([{ jobId: spec.jobId, conversationId: 'conv-1', iteration: 1 }]);
  });

  it('stops also when generate fails, and the job still stops with the reason of the failure', async () => {
    const log: string[] = [];
    const backend = new GatedBackend(log);
    const { port } = fakePort(log);
    const { store, spec } = await run({
      backend,
      generationProgress: port,
      settle: async () => {
        await backend.inGenerate;
        backend.open(true);
      },
    });
    expect(log).toEqual(['start', 'generate:begin', 'generate:end', 'stop']);
    expect(await store.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'error', detail: expect.stringContaining('生成の段') },
    });
  });

  it('passes no conversation for a job that does not belong to one', async () => {
    const log: string[] = [];
    const backend = new GatedBackend(log);
    const { port, starts } = fakePort(log);
    await run({
      backend,
      generationProgress: port,
      settle: async () => {
        await backend.inGenerate;
        backend.open();
      },
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.conversationId).toBeUndefined();
  });

  it('runs as before without generationProgress, with the same number of LLM calls', async () => {
    const withLog: string[] = [];
    const withBackend = new GatedBackend(withLog);
    const { port } = fakePort(withLog);
    const withPort = await run({
      backend: withBackend,
      generationProgress: port,
      conversationId: 'conv-1',
      settle: async () => {
        await withBackend.inGenerate;
        withBackend.open();
      },
    });
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'drawroid-runner-progress-'));

    const without = await run({ backend: new StubBackend(), conversationId: 'conv-1' });
    expect(await without.store.readState(without.spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'limit:iterations' },
    });
    expect(without.llm.calls.length).toBeGreaterThan(0);
    expect(withPort.llm.calls.length).toBe(without.llm.calls.length);
  });
});
