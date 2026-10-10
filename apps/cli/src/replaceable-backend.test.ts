import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackendBusyError } from '@drawroid/api';
import {
  BackendError,
  basicPermissions,
  DEFAULT_BUDGET,
  generationRequestSchema,
  JobRunner,
  ManualGenerationRunner,
  type GenerationImages,
  type GenerationProgress,
  type GenerationRequest,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { blocking } from '@drawroid/storage-fs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReplaceableBackend } from './replaceable-backend.js';

// schema を通して作る: 要求に欄が足されても、既定値のある欄はここで埋まるため
const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

// 中の backend が受け取った画像を残す: 包みが引数を落としても型では見つからないため、届いたものを見る
class ImageRecordingBackend extends StubBackend {
  readonly receivedImages: (GenerationImages | undefined)[] = [];

  override generate(req: GenerationRequest, signal: AbortSignal, images?: GenerationImages) {
    this.receivedImages.push(images);
    return super.generate(req, signal, images);
  }
}

// progress を持つ backend。受け取った引数を残す: 包みが引数を落としても型では見つからないため
class ProgressBackend extends StubBackend {
  readonly calls: { signal: AbortSignal; options: { includePreview?: boolean } | undefined }[] = [];

  constructor(private readonly reported: GenerationProgress | undefined) {
    super();
  }

  progress(signal: AbortSignal, options?: { includePreview?: boolean }) {
    this.calls.push({ signal, options });
    return Promise.resolve(this.reported);
  }
}

describe('ReplaceableBackend', () => {
  it('asks the backend it holds for the progress, passing the arguments on', async () => {
    const reported = { fraction: 0.5, step: 2, steps: 4, etaSeconds: null };
    const inner = new ProgressBackend(reported);
    const backend = new ReplaceableBackend(inner);
    const signal = new AbortController().signal;

    expect(await backend.progress(signal, { includePreview: true })).toEqual(reported);
    expect(inner.calls).toEqual([{ signal, options: { includePreview: true } }]);
  });

  it('reports nothing running when the backend it holds has no progress', async () => {
    const backend = new ReplaceableBackend(new StubBackend());
    expect(await backend.progress(new AbortController().signal)).toBeUndefined();
  });

  it('asks the replacement for the progress once it has been replaced', async () => {
    const first = new ProgressBackend(undefined);
    const second = new ProgressBackend({ fraction: 1, step: null, steps: null, etaSeconds: null });
    const backend = new ReplaceableBackend(first);
    backend.replace(second);
    await backend.progress(new AbortController().signal);
    expect(first.calls).toEqual([]);
    expect(second.calls).toHaveLength(1);
  });

  it('passes the input images on to the backend it holds', async () => {
    const inner = new ImageRecordingBackend();
    const backend = new ReplaceableBackend(inner);
    const img2img = generationRequestSchema.parse({
      prompt: 'a cat',
      steps: 4,
      cfgScale: 7,
      width: 64,
      height: 64,
      img2img: { image: 'source', denoisingStrength: 0.5 },
    });
    const images: GenerationImages = new Map([
      ['source', { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
    ]);

    await backend.generate(img2img, new AbortController().signal, images);

    expect(inner.receivedImages).toEqual([images]);
  });

  it('delegates to the backend it was given', async () => {
    const first = new StubBackend();
    const backend = new ReplaceableBackend(first);
    await backend.generate(request, new AbortController().signal);
    expect(first.requests).toHaveLength(1);
    expect(await backend.listCandidates('lora')).toEqual(await first.listCandidates('lora'));
  });

  it('sends generations to the new backend after replace', async () => {
    const first = new StubBackend();
    const second = new StubBackend();
    const backend = new ReplaceableBackend(first);
    backend.replace(second);
    await backend.generate(request, new AbortController().signal);
    expect(first.requests).toEqual([]);
    expect(second.requests).toHaveLength(1);
  });

  it('refuses to replace while a generation runs, so interrupt still reaches it', async () => {
    const first = new StubBackend({ generateDelayMs: 20 });
    const second = new StubBackend();
    const backend = new ReplaceableBackend(first);
    const running = backend.generate(request, new AbortController().signal);
    expect(() => backend.replace(second)).toThrow(BackendBusyError);
    await backend.interrupt();
    expect(first.interruptCount).toBe(1);
    await running;
    expect(second.requests).toEqual([]);
  });

  describe('one generation at a time', () => {
    // 試験が release() するまで生成を返さない: 「走っている間」を時間に頼らずに作るため
    class HeldBackend extends StubBackend {
      readonly entered: string[] = [];
      private releases: (() => void)[] = [];
      private waiting: { count: number; resolve: () => void }[] = [];

      override async generate(
        req: GenerationRequest,
        signal: AbortSignal,
        images?: GenerationImages,
      ) {
        this.entered.push(req.prompt);
        for (const wait of this.waiting.filter(({ count }) => this.entered.length >= count)) {
          this.waiting.splice(this.waiting.indexOf(wait), 1);
          wait.resolve();
        }
        await new Promise<void>((resolve) => this.releases.push(resolve));
        return super.generate(req, signal, images);
      }

      /** count 回目の生成が中身に届いたら解ける */
      reached(count: number): Promise<void> {
        if (this.entered.length >= count) return Promise.resolve();
        return new Promise((resolve) => this.waiting.push({ count, resolve }));
      }

      /** いちばん古い、止めてある生成を返させる */
      release(): void {
        this.releases.shift()?.();
      }
    }
    const asking = (prompt: string) => generationRequestSchema.parse({ ...request, prompt });

    // 手動の生成と自動のジョブの生成は、どちらもこの入れ物を通る。GPU は1枚と仮定するので、重ねて投げない
    it('does not hand a generation to the backend while another one runs', async () => {
      const inner = new HeldBackend();
      const backend = new ReplaceableBackend(inner);
      const first = backend.generate(asking('first'), new AbortController().signal);
      await inner.reached(1);

      const second = backend.generate(asking('second'), new AbortController().signal);
      expect(inner.entered).toEqual(['first']);

      inner.release();
      await first;
      await inner.reached(2);
      expect(inner.entered).toEqual(['first', 'second']);
      inner.release();
      await second;
    });

    // 待たせるのは生成だけ: 進み具合と中断が待たされると、走っている生成を見ることも止めることもできなくなるため
    it('still reaches the backend for the progress and the interrupt while a generation runs', async () => {
      const inner = new HeldBackend();
      const backend = new ReplaceableBackend(inner);
      const first = backend.generate(asking('first'), new AbortController().signal);
      await inner.reached(1);
      const second = backend.generate(asking('second'), new AbortController().signal);

      expect(await backend.progress(new AbortController().signal)).toBeUndefined();
      await backend.interrupt();
      expect(inner.interruptCount).toBe(1);
      expect(await backend.listCandidates('lora')).toEqual(await inner.listCandidates('lora'));

      inner.release();
      await first;
      await inner.reached(2);
      inner.release();
      await second;
    });

    it('drops a waiting generation that is stopped, without handing it to the backend or holding up the next', async () => {
      const inner = new HeldBackend();
      const backend = new ReplaceableBackend(inner);
      const first = backend.generate(asking('first'), new AbortController().signal);
      await inner.reached(1);
      const stopping = new AbortController();
      const second = backend.generate(asking('second'), stopping.signal);
      const third = backend.generate(asking('third'), new AbortController().signal);

      stopping.abort();
      await expect(second).rejects.toThrow();
      // 抜けた生成の後ろも、前の生成が終わるまでは待つ
      expect(inner.entered).toEqual(['first']);
      inner.release();
      await first;
      await inner.reached(2);
      expect(inner.entered).toEqual(['first', 'third']);
      inner.release();
      await third;
    });

    it('lets the next generation run after one that failed', async () => {
      const inner = new StubBackend();
      inner.failNextGenerate(new BackendError('failed', 'out of memory'));
      const backend = new ReplaceableBackend(inner);
      const failing = backend.generate(asking('first'), new AbortController().signal);
      const next = backend.generate(asking('second'), new AbortController().signal);

      await expect(failing).rejects.toThrow();
      await next;
      expect(inner.requests.map((sent) => sent.prompt)).toEqual(['first', 'second']);
    });

    // 組み立てと同じく、手動の生成と自動のジョブに同じ入れ物を握らせる
    describe('between a manual generation and an automatic job', () => {
      let root: string;
      beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'drawroid-replaceable-'));
      });
      afterEach(async () => {
        await rm(root, { recursive: true, force: true });
      });

      const think: Script = () => ({
        params: { prompt: 'auto', negativePrompt: '', seed: 1, steps: 4, cfgScale: 7 },
        rationale: '案',
      });
      const judge: Script = (call) => ({
        images: call.messages.user
          .filter((part) => part.type === 'image')
          .map(() => ({ score: 0.5, issues: [] })),
        nextChange: 'そのまま',
        canStop: false,
      });

      function setup(inner: StubBackend, thinkScript: Script = think) {
        const store = new FsJobStore(root);
        const backend = new ReplaceableBackend(inner);
        const runner = new JobRunner({
          store,
          llm: new ScriptedLlm({ think: thinkScript, judge }),
          backend,
          budget: DEFAULT_BUDGET,
          permissions: basicPermissions({ width: 64, height: 64 }),
        });
        const manual = new ManualGenerationRunner({ backend, store });
        // 手動の生成が入れ物まで来たら解ける: 手動は状態を書いてから入れ物を呼ぶので、受けた直後ではまだ来ていないため
        let arrived!: () => void;
        const manualArrived = new Promise<void>((resolve) => (arrived = resolve));
        const generate = backend.generate.bind(backend);
        backend.generate = (req, signal, images) => {
          const result = generate(req, signal, images);
          if (req.prompt === 'manual') arrived();
          return result;
        };
        const submitAuto = () =>
          store.createJob(
            {
              kind: 'auto',
              request: '夕暮れの海辺',
              stopConditions: { aiJudgement: false, maxIterations: 1 },
              batchSize: 1,
            },
            { status: 'queued', carry: { intent: '夕暮れの海辺', completedIterations: 0 } },
            new Date(),
          );
        return { runner, manual, submitAuto, manualArrived };
      }

      it('holds a manual generation back while the job generates', async () => {
        const inner = new HeldBackend();
        const { runner, manual, submitAuto, manualArrived } = setup(inner);
        await submitAuto();
        runner.kick();
        await inner.reached(1);

        await manual.start({ ...request, prompt: 'manual' });
        await manualArrived;
        expect(inner.entered).toEqual(['auto']);

        inner.release();
        await inner.reached(2);
        expect(inner.entered).toEqual(['auto', 'manual']);
        inner.release();
        await runner.idle();
        await manual.idle();
      });

      // 1回の生成の間だけ待たせる: 手動の生成を、自動のジョブが止まるまで待たせない
      it('lets a manual generation run while the job is thinking', async () => {
        const thinking = blocking(think, (n) => n === 0);
        const { runner, manual, submitAuto } = setup(new StubBackend(), thinking.script);
        await submitAuto();
        runner.kick();
        await thinking.reached(1);

        const { jobId } = await manual.start({ ...request, prompt: 'manual' });
        await manual.idle();
        expect(await new FsJobStore(root).readState(jobId)).toMatchObject({ status: 'stopped' });

        thinking.answer(0);
        await runner.idle();
      });
    });
  });

  it('can be replaced again once the generation has ended, even when it failed', async () => {
    const first = new StubBackend();
    first.failNextGenerate(new BackendError('failed', 'out of memory'));
    const backend = new ReplaceableBackend(first);
    await expect(backend.generate(request, new AbortController().signal)).rejects.toThrow();
    const second = new StubBackend();
    expect(backend.replace(second)).toBe(first);
  });
});
