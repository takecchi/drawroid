// M6:156「M1〜M5 のスタブのテストが、アダプタでも通る」を満たす通しの試験。ループ（core の JobRunner）を本物のファイルの
// 置き場所（FsJobStore）の上で、本物のアダプタ（偽の Forge / 偽の A1111 に繋いだもの）を通して回し、M1〜M5 の振る舞いを見る。
// 試験の本体はここに1度だけ書き、各アダプタのパッケージが describeLoopScenarios(name, target) で同じ試験を当てる。
// LLM は台本どおりに返すスタブ。バックエンドの外から見えるのは、偽のサーバが受けた sdapi の要求だけ
// （Forge も A1111 も要求の形は同じ sdapi で、ControlNet の欄名も同じ 'controlnet'）
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  ManualGenerationRunner,
  mergePermissions,
  type AutoJobSpec,
  type ImageBackend,
  type JobState,
  type LlmCall,
  type MemoryItem,
  type Permissions,
} from '@drawroid/core';
import { ScriptedLlm, STUB_PNG, type Script } from '@drawroid/core/testing';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFsDistillLog } from '../distill/log.js';
import { FsJobStore } from '../job-store.js';
import { createFsMemoryStore } from '../memory/store.js';
import { dataPaths } from '../paths.js';
import { solidPng } from './solid-png.js';

export interface LoopMockRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
export type LoopMockHandler = (req: LoopMockRequest, res: ServerResponse) => void;

export interface StartLoopBackendOptions {
  /** 生成を通した n 番目（0 始まり）が返す画像。渡さなければ中身の無い画像 */
  generatedImage?: (n: number) => Uint8Array;
  /** ControlNet が入った構成にする */
  controlnet?: boolean;
}

export interface RunningLoopBackend {
  backend: ImageBackend;
  /** 偽のサーバが受けた要求 */
  requests: LoopMockRequest[];
  /** 1つの経路の応答を差し替える。key は 'POST /sdapi/v1/txt2img' の形 */
  route(key: string, handler: LoopMockHandler): void;
  close(): Promise<void>;
}

export interface LoopBackendTarget {
  start(options: StartLoopBackendOptions): Promise<RunningLoopBackend>;
  /** 繋がらないバックエンド（落ちている・ポートが違う） */
  unreachable(): Promise<ImageBackend>;
  /** 偽のサーバの、中身の無い画像を返す既定の生成の応答 */
  respondToGeneration: LoopMockHandler;
  /** controlnet: true で起こしたバックエンドが候補に挙げる ControlNet のモデル（雛形が実機ごとに違うので、呼び出し側が決める） */
  controlnetModel: string;
}

const REQUEST = '夕暮れの海辺に立つ白いワンピースの少女、アニメ調';

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

const imagesOf = (call: LlmCall<unknown>) => call.messages.user.filter((p) => p.type === 'image');
const imageKeysOf = (call: LlmCall<unknown>) =>
  call.messages.user.flatMap((p) => (p.type === 'image' ? [p.key] : []));
const textOf = (call: LlmCall<unknown> | undefined) =>
  (call?.messages.user ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** stopAt 回目（1始まり）で「止めてよい」と言う見る役。言わせないなら undefined */
function judge(stopAt?: number): Script {
  return (call, n) => ({
    images: imagesOf(call).map((_, i) => ({
      score: 0.3 + n * 0.1 + i * 0.01,
      issues: ['背景が暗い'],
    })),
    nextChange: 'もっと逆光にする',
    canStop: stopAt !== undefined && n + 1 >= stopAt,
  });
}

const paramKeysOf = (call: LlmCall<unknown>) => {
  const json = z.toJSONSchema(call.schema) as unknown as {
    properties: { params: { properties?: object } };
  };
  return Object.keys(json.properties.params.properties ?? {}).sort();
};

const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');
// n 番目の生成が返す画像。色も大きさも回ごとに違う（元画像とマスクと別の回の画像を、取り違えたときに見分けるため）
const generatedPng = (n: number) => solidPng([40 + n * 60, 20, 20], 2 + n);
// 人間が塗るマスク。どの生成画像とも中身が違う
const MASK_PNG = solidPng([255, 255, 255], 7);

const respondJson =
  (status: number, body: unknown): LoopMockHandler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

export function describeLoopScenarios(name: string, target: LoopBackendTarget): void {
  describe(`the loop over ${name}`, () => {
    let root: string;
    let store: FsJobStore;
    const closers: (() => Promise<void>)[] = [];

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'drawroid-loop-scenarios-'));
      store = new FsJobStore(root);
    });
    afterEach(async () => {
      for (const close of closers.splice(0)) await close();
      await rm(root, { recursive: true, force: true });
    });

    async function open(options: StartLoopBackendOptions = {}) {
      const running = await target.start(options);
      closers.push(() => running.close());
      return running;
    }

    function runnerOn(
      backend: ImageBackend,
      scripts: ConstructorParameters<typeof ScriptedLlm>[0],
      {
        permissions = basicPermissions({ width: 64, height: 64 }),
        jobStore = store,
        memory,
      }: {
        permissions?: Permissions;
        jobStore?: FsJobStore;
        memory?: JobRunnerMemory;
      } = {},
    ) {
      const llm = new ScriptedLlm(scripts);
      const runner = new JobRunner({
        store: jobStore,
        llm,
        backend,
        budget: DEFAULT_BUDGET,
        permissions,
        ...(memory === undefined ? {} : { memory }),
      });
      return { llm, runner };
    }

    async function submit(
      conditions: AutoJobSpec['stopConditions'],
      batchSize = 2,
      request = REQUEST,
    ): Promise<AutoJobSpec> {
      const spec = await store.createJob(
        { kind: 'auto', request, stopConditions: conditions, batchSize },
        { status: 'queued', carry: { intent: request, completedIterations: 0 } },
        new Date(),
      );
      if (spec.kind !== 'auto') throw new Error('auto のはず');
      return spec;
    }

    async function stopped(jobId: string, from: FsJobStore = store) {
      const state: JobState = await from.readState(jobId);
      if (state.status !== 'stopped') throw new Error(`止まっていない: ${state.status}`);
      return state;
    }

    const posted = (running: RunningLoopBackend, path: string) =>
      running.requests
        .filter((r) => r.method === 'POST' && r.path === path)
        .map((r) => JSON.parse(r.body) as Record<string, unknown>);
    const thinkCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.purpose === 'think');
    const judgeCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.purpose === 'judge');

    /** n 回目（1始まり）の生成の応答の前に action を走らせる */
    function beforeGeneration(running: RunningLoopBackend, n: number, action: () => Promise<void>) {
      let count = 0;
      running.route('POST /sdapi/v1/txt2img', async (req, res) => {
        count += 1;
        if (count === n) await action();
        target.respondToGeneration(req, res);
      });
    }

    describe('M1: a manual generation and a backend that is down', () => {
      it('generates, saves and reads back the images the backend returned', async () => {
        const running = await open();
        const manual = new ManualGenerationRunner({ backend: running.backend, store });
        const { jobId } = await manual.start({
          prompt: 'a cat',
          steps: 4,
          cfgScale: 7,
          seed: 42,
          width: 64,
          height: 64,
          batchSize: 2,
        });
        await manual.idle();

        expect((await stopped(jobId)).reason.kind).toBe('limit:iterations');
        const generation = await store.readGeneration(jobId, 1);
        expect(generation?.images.map((image) => image.seed)).toEqual([42, 43]);
        expect(posted(running, '/sdapi/v1/txt2img')).toMatchObject([
          { prompt: 'a cat', batch_size: 2 },
        ]);
        const saved = await store.readImage({ jobId, iteration: 1, index: 1 });
        expect(Buffer.from(saved ?? []).equals(Buffer.from(STUB_PNG))).toBe(true);
      });

      it('stops the job before thinking, with the reason, when the backend is down', async () => {
        const { llm, runner } = runnerOn(await target.unreachable(), {
          think,
          judge: judge(),
        });
        const spec = await submit({ aiJudgement: true, maxIterations: 5 });
        runner.kick();
        await runner.idle();

        const { reason } = await stopped(spec.jobId);
        expect(reason).toMatchObject({ kind: 'error', backendErrorKind: 'unreachable' });
        expect(reason.detail).toMatch(/^バックエンドの能力と候補を取る段: /);
        expect(llm.calls).toEqual([]);
      });

      it('stops the job naming the generation stage when the backend answers with an error', async () => {
        const running = await open();
        running.route('POST /sdapi/v1/txt2img', respondJson(500, { error: 'boom' }));
        const { runner } = runnerOn(running.backend, { think, judge: judge() });
        const spec = await submit({ aiJudgement: true, maxIterations: 5 });
        runner.kick();
        await runner.idle();

        const { reason } = await stopped(spec.jobId);
        expect(reason.kind).toBe('error');
        expect(reason.detail).toMatch(/^生成の段: /);
      });
    });

    describe('M2: the loop stops and resumes', () => {
      it('runs think, generate and judge until the judge says the intent is met', async () => {
        const running = await open();
        const { runner } = runnerOn(running.backend, { think, judge: judge(2) });
        const spec = await submit({ aiJudgement: true, maxIterations: 5 });
        runner.kick();
        await runner.idle();

        const state = await stopped(spec.jobId);
        expect(state.reason.kind).toBe('ai');
        expect(state.carry?.completedIterations).toBe(2);
        expect(state.imagesGenerated).toBe(4);
        // 考える役が決めた値が、そのままバックエンドの txt2img に届いている
        expect(posted(running, '/sdapi/v1/txt2img')).toMatchObject([
          { prompt: 'girl, beach, sunset, take 1', seed: 1234, steps: 28, batch_size: 2 },
          { prompt: 'girl, beach, sunset, take 2', seed: 1235, steps: 28, batch_size: 2 },
        ]);
        // バックエンドが返した画像と seed が、回の記録に残っている
        const second = await store.readGeneration(spec.jobId, 2);
        expect(second?.request.prompt).toBe('girl, beach, sunset, take 2');
        expect(second?.images.map((image) => image.seed)).toEqual([1235, 1236]);
      });

      it('stops at the iteration limit', async () => {
        const running = await open();
        const { runner } = runnerOn(running.backend, { think, judge: judge() });
        const spec = await submit({ aiJudgement: true, maxIterations: 3 });
        runner.kick();
        await runner.idle();

        expect((await stopped(spec.jobId)).reason.kind).toBe('limit:iterations');
        expect(posted(running, '/sdapi/v1/txt2img')).toHaveLength(3);
      });

      it('interrupts the backend when a human stops the job during generation', async () => {
        const running = await open();
        // 中断されるまで txt2img に答えない
        let release: (() => void) | undefined;
        running.route('POST /sdapi/v1/txt2img', (req, res) => {
          release = () => target.respondToGeneration(req, res);
        });
        running.route('POST /sdapi/v1/interrupt', (req, res) => {
          respondJson(200, {})(req, res);
          release?.();
        });
        const { runner } = runnerOn(running.backend, { think, judge: judge() });
        const spec = await submit({ aiJudgement: true, maxIterations: 5 });
        runner.kick();
        while (release === undefined) await new Promise((r) => setTimeout(r, 5));
        await runner.stop(spec.jobId);
        await runner.idle();

        expect((await stopped(spec.jobId)).reason.kind).toBe('human');
        expect(posted(running, '/sdapi/v1/interrupt')).toHaveLength(1);
      });

      it('passes each generated image to the judge exactly once, shrunk to the long edge', async () => {
        const big = await sharp({
          create: { width: 1024, height: 768, channels: 3, background: '#884422' },
        })
          .png()
          .toBuffer();
        const running = await open({ generatedImage: () => big });
        const { runner, llm } = runnerOn(
          running.backend,
          { think, judge: judge() },
          { permissions: basicPermissions({ width: 1024, height: 768 }) },
        );
        await submit({ aiJudgement: true, maxIterations: 3 }, 2);
        runner.kick();
        await runner.idle();

        const images = llm.calls.flatMap(imagesOf);
        expect(images).toHaveLength(6);
        expect(new Set(images.map((i) => i.key)).size).toBe(6);
        for (const image of images) {
          const meta = await sharp(image.data).metadata();
          expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
            DEFAULT_BUDGET.imageLongEdge,
          );
        }
        expect(thinkCalls(llm).every((c) => imagesOf(c).length === 0)).toBe(true);
      });

      it('resumes in a new runner on the same data directory, from the stage where the old one stopped', async () => {
        const running = await open();
        // 1つ目のプロセス: 2回目の「見る」の途中で返らなくなる（そこで落ちたものとみなす）
        const first = runnerOn(running.backend, {
          think,
          judge: (call, n) => (n === 1 ? new Promise(() => undefined) : judge()(call, n)),
        });
        const spec = await submit({ aiJudgement: true, maxIterations: 3 });
        first.runner.kick();
        while (judgeCalls(first.llm).length < 2) await new Promise((r) => setTimeout(r, 5));

        // 2つ目のプロセス: 同じデータディレクトリから、新しい置き場所と新しいランナーで起動し直す
        const reopened = new FsJobStore(root);
        const second = runnerOn(
          running.backend,
          { think: (c, n) => think(c, n + 2), judge: judge() },
          { jobStore: reopened },
        );
        second.runner.kick();
        await second.runner.idle();

        const state = await stopped(spec.jobId, reopened);
        expect(state.reason.kind).toBe('limit:iterations');
        expect(state.carry?.completedIterations).toBe(3);
        // 2回目は「見る」からやり直し、3回目だけを新しく考えて生成した
        expect(second.llm.calls.map((c) => c.purpose)).toEqual(['judge', 'think', 'judge']);
        expect(posted(running, '/sdapi/v1/txt2img')).toHaveLength(3);
      });
    });

    describe('M3: a human steps in while the job runs', () => {
      const INTEGRATED = '逆光で夕暮れの海辺に立つ白いワンピースの少女、アニメ調';
      const thinkIntegrating: Script = (call, n) => ({
        ...(think(call, n) as object),
        intent: INTEGRATED,
      });

      it('lets the image being generated finish, and takes the instruction into the next think', async () => {
        const running = await open();
        const { runner, llm } = runnerOn(running.backend, {
          think: thinkIntegrating,
          judge: judge(),
        });
        const spec = await submit({ aiJudgement: false, maxIterations: 3 });
        beforeGeneration(running, 1, async () => {
          await runner.addInstruction(spec.jobId, '逆光にして');
        });
        runner.kick();
        await runner.idle();

        expect(posted(running, '/sdapi/v1/interrupt')).toHaveLength(0);
        expect(posted(running, '/sdapi/v1/txt2img')).toHaveLength(3);
        const [first, second, third] = thinkCalls(llm);
        expect(textOf(first)).not.toContain('逆光にして');
        expect(textOf(second).split('人間の指示:')[1]).toContain('逆光にして');
        // 原文は積み増さず、統合した要点だけが以後に残る
        expect(textOf(third)).not.toContain('人間の指示');
        expect(textOf(third)).toContain(INTEGRATED);
        expect((await stopped(spec.jobId)).carry?.intent).toBe(INTEGRATED);
      });

      it('shows a reference image once to the LLM, shrunk, and only its gist afterwards', async () => {
        const GIST = '逆光の海辺、白いワンピースの裾が風になびく構図';
        const running = await open();
        const { runner, llm } = runnerOn(running.backend, {
          think,
          judge: judge(),
          'ref-gist': () => ({ gist: GIST }),
        });
        const spec = await submit({ aiJudgement: false, maxIterations: 3 });
        const original = await sharp({
          create: { width: 2000, height: 1200, channels: 3, background: '#2266aa' },
        })
          .jpeg()
          .toBuffer();
        const reference = await store.addReference(
          spec.jobId,
          { data: original, mediaType: 'image/jpeg', note: 'この構図で' },
          new Date(),
        );
        runner.kick();
        await runner.idle();

        const refKey = `jobs/${spec.jobId}/refs/${reference.refId}`;
        const carrying = llm.calls.filter((call) => imageKeysOf(call).includes(refKey));
        expect(carrying).toHaveLength(1);
        const shown = imagesOf(carrying[0]!)[0];
        const { width = 0, height = 0 } = await sharp(shown?.data).metadata();
        expect(Math.max(width, height)).toBeLessThanOrEqual(DEFAULT_BUDGET.imageLongEdge);
        for (const call of llm.calls.slice(llm.calls.indexOf(carrying[0]!) + 1)) {
          expect(imageKeysOf(call)).not.toContain(refKey);
          expect(textOf(call)).toContain(GIST);
        }
      });

      it('changes the stop condition while the job runs, finishing the iteration being generated', async () => {
        const running = await open();
        const { runner } = runnerOn(running.backend, { think, judge: judge() });
        const spec = await submit({ aiJudgement: false, maxIterations: 5 });
        beforeGeneration(running, 1, async () => {
          await runner.changeStopConditions(spec.jobId, { maxIterations: 2 });
        });
        runner.kick();
        await runner.idle();

        const state = await stopped(spec.jobId);
        expect(state.reason).toEqual({ kind: 'limit:iterations', detail: '2 回に達した' });
        expect(posted(running, '/sdapi/v1/txt2img')).toHaveLength(2);
      });
    });

    describe('M4: the parameters the permissions leave to the AI', () => {
      const base = basicPermissions({ width: 64, height: 64 });
      const decided = {
        prompt: 'girl, beach, sunset',
        negativePrompt: 'lowres',
        seed: 7,
        steps: 20,
        cfgScale: 6,
      };
      const submitOnce = (maxIterations: number) =>
        submit({ aiJudgement: false, maxIterations }, 1, '夕暮れの海辺に立つ少女、アニメ調');
      const m4Think =
        (choose: Record<string, unknown>): Script =>
        (call) => ({
          params: {
            ...decided,
            ...Object.fromEntries(
              Object.entries(choose).filter(([key]) => paramKeysOf(call).includes(key)),
            ),
          },
          rationale: '案',
        });

      it('generates with the checkpoint the thinking role chose among those the backend lists', async () => {
        const running = await open({ generatedImage: generatedPng });
        const { llm, runner } = runnerOn(
          running.backend,
          { think: m4Think({ checkpoint: 'real/juggernaut-xl.safetensors' }), judge: judge() },
          { permissions: mergePermissions(base, { checkpoint: { mode: 'auto' } }) },
        );
        await submitOnce(1);
        runner.kick();
        await runner.idle();

        const text = textOf(thinkCalls(llm)[0]);
        expect(text).toContain('animagine-xl-4.0');
        expect(text).toContain('real/juggernaut-xl.safetensors');
        expect(posted(running, '/sdapi/v1/txt2img')).toMatchObject([
          {
            override_settings: { sd_model_checkpoint: 'real/juggernaut-xl.safetensors' },
            override_settings_restore_afterwards: true,
          },
        ]);
      });

      it('starts img2img from the best image so far, sending that image as init_images', async () => {
        const running = await open({ generatedImage: generatedPng });
        const { llm, runner } = runnerOn(
          running.backend,
          {
            think: m4Think({ img2img: { image: 'best', denoisingStrength: 0.5 } }),
            judge: judge(),
          },
          { permissions: mergePermissions(base, { img2img: { mode: 'auto' } }) },
        );
        await submitOnce(2);
        runner.kick();
        await runner.idle();

        const [first, second] = thinkCalls(llm);
        expect(paramKeysOf(first!)).not.toContain('img2img');
        expect(paramKeysOf(second!)).toContain('img2img');
        expect(posted(running, '/sdapi/v1/txt2img')).toHaveLength(1);
        // 元画像は 1回目の画像であって、2回目に返ってくる画像（img2img の応答）ではない
        expect(posted(running, '/sdapi/v1/img2img')).toMatchObject([
          { init_images: [b64(generatedPng(0))], denoising_strength: 0.5 },
        ]);
        expect(b64(generatedPng(1))).not.toBe(b64(generatedPng(0)));
      });

      it('repaints with the mask the human painted on a running job, and not before it exists', async () => {
        const running = await open({ generatedImage: generatedPng });
        let jobId = '';
        const set = runnerOn(
          running.backend,
          {
            think: m4Think({ inpaint: { denoisingStrength: 0.6 } }),
            // 1回目を見ている間に、人間が1回目の画像にマスクを塗る
            judge: async (call, n) => {
              if (n === 0) {
                await set.runner.addMask(jobId, {
                  image: { iteration: 1, index: 0 },
                  data: MASK_PNG,
                });
              }
              return judge()(call, n);
            },
          },
          { permissions: mergePermissions(base, { inpaint: { mode: 'auto' } }) },
        );
        jobId = (await submitOnce(3)).jobId;
        set.runner.kick();
        await set.runner.idle();

        const [first, second, third] = thinkCalls(set.llm);
        expect(paramKeysOf(first!)).not.toContain('inpaint');
        expect(paramKeysOf(second!)).toContain('inpaint');
        expect(paramKeysOf(third!)).not.toContain('inpaint');
        // マスクが無い 1回目は txt2img。マスクが届いた 2回目だけ mask 付きの img2img。マスクを手放した 3回目は txt2img
        expect(posted(running, '/sdapi/v1/txt2img')).toHaveLength(2);
        const img2img = posted(running, '/sdapi/v1/img2img');
        expect(img2img).toHaveLength(1);
        // init_images は 1回目の画像（マスクを塗った画像）、mask は人間のマスク。取り違えず、互いに別の中身
        expect(img2img[0]).toMatchObject({
          init_images: [b64(generatedPng(0))],
          mask: b64(MASK_PNG),
          denoising_strength: 0.6,
        });
        expect(b64(MASK_PNG)).not.toBe(b64(generatedPng(0)));
      });

      it('sends the model and the image the thinking role chose in the ControlNet unit', async () => {
        const model = target.controlnetModel;
        const running = await open({ generatedImage: generatedPng, controlnet: true });
        const { llm, runner } = runnerOn(
          running.backend,
          {
            think: m4Think({ controlnet: { model, module: 'canny', image: 'best' } }),
            judge: judge(),
          },
          { permissions: mergePermissions(base, { controlnet: { mode: 'auto' } }) },
        );
        await submitOnce(2);
        runner.kick();
        await runner.idle();

        const [first, second] = thinkCalls(llm);
        // 1回目は見せた画像が無いので出ない。2回目はバックエンドが返したモデルが候補に載る
        expect(paramKeysOf(first!)).not.toContain('controlnet');
        expect(paramKeysOf(second!)).toContain('controlnet');
        expect(textOf(second)).toContain(model);
        const [firstBody, secondBody] = posted(running, '/sdapi/v1/txt2img');
        expect(firstBody!.alwayson_scripts).toBeUndefined();
        const { args } = (
          secondBody!.alwayson_scripts as { controlnet: { args: Record<string, unknown>[] } }
        ).controlnet;
        expect(args[0]).toMatchObject({
          enabled: true,
          model,
          module: 'canny',
          image: b64(generatedPng(0)),
        });
      });
    });

    describe('M5: the preferences in memory', () => {
      const FINGERS = '指の崩れは許容しない';
      const now = '2026-01-01T00:00:00+09:00';
      const item = (id: string, body: string): MemoryItem => ({
        id,
        body,
        tags: [],
        scope: 'always',
        sources: [],
        createdAt: now,
        updatedAt: now,
      });
      const memoryOf = () => ({
        store: createFsMemoryStore(dataPaths(root).memory),
        distillLog: createFsDistillLog(root),
      });

      it('puts a preference in the input of the judging role', async () => {
        const running = await open();
        const memory = memoryOf();
        await memory.store.put(item('fingers', FINGERS));
        const { llm, runner } = runnerOn(
          running.backend,
          { think, judge: judge(1), distill: () => ({ operations: [] }) },
          { memory },
        );
        await submit({ aiJudgement: true, maxIterations: 1 }, 1);
        runner.kick();
        await runner.idle();

        expect(textOf(judgeCalls(llm)[0])).toContain(FINGERS);
        expect(textOf(thinkCalls(llm)[0])).toContain(FINGERS);
      });

      it('writes what a stopped job taught to memory, which the judging role of the next job sees', async () => {
        const running = await open();
        const memory = memoryOf();
        const { llm, runner } = runnerOn(
          running.backend,
          {
            think,
            judge: judge(1),
            distill: () => ({
              operations: [{ op: 'add', body: FINGERS, tags: [], scope: 'always' }],
            }),
          },
          { memory },
        );
        const first = await submit({ aiJudgement: true, maxIterations: 1 }, 1);
        await runner.addInstruction(first.jobId, '指の崩れは許さない');
        runner.kick();
        await runner.idle();
        expect((await memory.store.list()).items.map((i) => i.body)).toEqual([FINGERS]);

        await submit({ aiJudgement: true, maxIterations: 1 }, 1, '雨の街角の猫');
        runner.kick();
        await runner.idle();

        expect(textOf(judgeCalls(llm).at(-1))).toContain(FINGERS);
      });
    });
  });
}

type JobRunnerMemory = NonNullable<ConstructorParameters<typeof JobRunner>[0]['memory']>;
