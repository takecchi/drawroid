// M6:156「M1〜M5 のスタブのテストが、A1111 のアダプタでも通る」のうち、M4（AI が触れるパラメータを広げ、設定で許可する）の
// 代表を、本物のアダプタで回して確かめる試験。loop.test.ts と同じく、LLM は台本どおりに返すスタブ、置き場所は本物のファイル、
// バックエンドは偽の A1111（雛形は実機の応答ではない。fixtures/README.md）に繋いだ A1111Backend。
// 見るのは、偽の A1111 が受けた要求の中身だけ
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  mergePermissions,
  type AutoJobSpec,
  type LlmCall,
  type Permissions,
} from '@drawroid/core';
import { ScriptedLlm, type Script } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { A1111Backend } from './a1111-backend.js';
import { solidPng, startMockA1111, type MockA1111 } from './test-support/mock-a1111.js';

let root: string;
let a1111: MockA1111 | undefined;
let store: FsJobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-a1111-m4-'));
  store = new FsJobStore(root);
});
afterEach(async () => {
  await a1111?.close();
  await rm(root, { recursive: true, force: true });
});

const base = basicPermissions({ width: 64, height: 64 });
const decided = {
  prompt: 'girl, beach, sunset',
  negativePrompt: 'lowres',
  seed: 7,
  steps: 20,
  cfgScale: 6,
};
// n 番目の生成が返す画像。色も大きさも回ごとに違う（init_images とマスクと別の回の画像を、取り違えたときに見分けるため）
const generatedPng = (n: number) => solidPng([40 + n * 60, 20, 20], 2 + n);
// 人間が塗るマスク。どの生成画像とも中身が違う
const MASK_PNG = solidPng([255, 255, 255], 7);
const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');

const paramKeysOf = (call: LlmCall<unknown>) => {
  const json = z.toJSONSchema(call.schema) as unknown as {
    properties: { params: { properties?: object } };
  };
  return Object.keys(json.properties.params.properties ?? {}).sort();
};
const textOf = (call: LlmCall<unknown>) =>
  call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** 考える役。出力スキーマにある欄にだけ、選んだ値を入れる */
function think(choose: Record<string, unknown> = {}): Script {
  return (call) => {
    const keys = paramKeysOf(call);
    return {
      params: {
        ...decided,
        ...Object.fromEntries(Object.entries(choose).filter(([key]) => keys.includes(key))),
      },
      rationale: '案',
    };
  };
}

function judge(onJudge?: (n: number) => Promise<void>): Script {
  return async (call, n) => {
    await onJudge?.(n);
    return {
      images: call.messages.user
        .filter((part) => part.type === 'image')
        .map((_, i) => ({ score: 0.5 + n * 0.1 + i * 0.01, issues: [] })),
      nextChange: 'なし',
      canStop: false,
    };
  };
}

async function setup(
  scripts: ConstructorParameters<typeof ScriptedLlm>[0],
  permissions: Permissions,
  options: { controlnet?: boolean } = {},
) {
  const mock = await startMockA1111({ ...options, generatedImage: generatedPng });
  a1111 = mock;
  const llm = new ScriptedLlm(scripts);
  const backend = new A1111Backend({ baseUrl: mock.url });
  const runner = new JobRunner({ store, llm, backend, budget: DEFAULT_BUDGET, permissions });
  return { mock, llm, runner };
}

async function submit(maxIterations: number): Promise<AutoJobSpec> {
  const request = '夕暮れの海辺に立つ少女、アニメ調';
  const spec = await store.createJob(
    { kind: 'auto', request, stopConditions: { aiJudgement: false, maxIterations }, batchSize: 1 },
    { status: 'queued', carry: { intent: request, completedIterations: 0 } },
    new Date(),
  );
  if (spec.kind !== 'auto') throw new Error('auto のはず');
  return spec;
}

const posted = (mock: MockA1111, path: string) =>
  mock.requests
    .filter((r) => r.method === 'POST' && r.path === path)
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
const thinkCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.purpose === 'think');

describe('the M4 loop over the A1111 adapter', () => {
  it('generates with the checkpoint the thinking role chose among those A1111 lists', async () => {
    const permissions = mergePermissions(base, { checkpoint: { mode: 'auto' } });
    const { mock, llm, runner } = await setup(
      { think: think({ checkpoint: 'real/juggernaut-xl.safetensors' }), judge: judge() },
      permissions,
    );
    await submit(1);

    runner.kick();
    await runner.idle();

    // A1111 の /sdapi/v1/sd-models の全モデルが、考える役の入力に候補として載る
    const text = textOf(thinkCalls(llm)[0]!);
    expect(text).toContain('animagine-xl-4.0');
    expect(text).toContain('real/juggernaut-xl.safetensors');
    expect(posted(mock, '/sdapi/v1/txt2img')).toMatchObject([
      {
        override_settings: { sd_model_checkpoint: 'real/juggernaut-xl.safetensors' },
        override_settings_restore_afterwards: true,
      },
    ]);
  });

  it('starts img2img from the best image so far, sending that image as init_images', async () => {
    const permissions = mergePermissions(base, { img2img: { mode: 'auto' } });
    const { mock, llm, runner } = await setup(
      {
        think: think({ img2img: { image: 'best', denoisingStrength: 0.5 } }),
        judge: judge(),
      },
      permissions,
    );
    await submit(2);

    runner.kick();
    await runner.idle();

    const [first, second] = thinkCalls(llm);
    expect(paramKeysOf(first!)).not.toContain('img2img');
    expect(paramKeysOf(second!)).toContain('img2img');
    // 1回目は txt2img、2回目は 1回目に A1111 が返した画像を元にした img2img
    expect(posted(mock, '/sdapi/v1/txt2img')).toHaveLength(1);
    // 元画像は 1回目の画像であって、2回目に返ってくる画像（img2img の応答）ではない
    expect(posted(mock, '/sdapi/v1/img2img')).toMatchObject([
      { init_images: [b64(generatedPng(0))], denoising_strength: 0.5 },
    ]);
    expect(b64(generatedPng(1))).not.toBe(b64(generatedPng(0)));
  });

  it('repaints with the mask the human painted on a running job, and not before it exists', async () => {
    const permissions = mergePermissions(base, { inpaint: { mode: 'auto' } });
    let jobId = '';
    const set = await setup(
      {
        think: think({ inpaint: { denoisingStrength: 0.6 } }),
        // 1回目を見ている間に、人間が1回目の画像にマスクを塗る
        judge: judge(async (n) => {
          if (n === 0) {
            await set.runner.addMask(jobId, { image: { iteration: 1, index: 0 }, data: MASK_PNG });
          }
        }),
      },
      permissions,
    );
    const spec = await submit(3);
    jobId = spec.jobId;

    set.runner.kick();
    await set.runner.idle();

    const [first, second, third] = thinkCalls(set.llm);
    expect(paramKeysOf(first!)).not.toContain('inpaint');
    expect(paramKeysOf(second!)).toContain('inpaint');
    expect(paramKeysOf(third!)).not.toContain('inpaint');
    // マスクが無い 1回目は txt2img。マスクが届いた 2回目だけ mask 付きの img2img。マスクを手放した 3回目は txt2img
    expect(posted(set.mock, '/sdapi/v1/txt2img')).toHaveLength(2);
    const img2img = posted(set.mock, '/sdapi/v1/img2img');
    expect(img2img).toHaveLength(1);
    // init_images は 1回目の画像（マスクを塗った画像）、mask は人間のマスク。取り違えず、互いに別の中身
    const initImage = b64(generatedPng(0));
    expect(img2img[0]).toMatchObject({
      init_images: [initImage],
      mask: b64(MASK_PNG),
      denoising_strength: 0.6,
    });
    expect(b64(MASK_PNG)).not.toBe(initImage);
  });

  it('sends the model and the image the thinking role chose in the ControlNet unit', async () => {
    const permissions = mergePermissions(base, { controlnet: { mode: 'auto' } });
    const model = 'control_v11p_sd15_canny [d14c016b]';
    const { mock, llm, runner } = await setup(
      {
        think: think({ controlnet: { model, module: 'canny', image: 'best' } }),
        judge: judge(),
      },
      permissions,
      { controlnet: true },
    );
    await submit(2);

    runner.kick();
    await runner.idle();

    const [first, second] = thinkCalls(llm);
    // 1回目は見せた画像が無いので出ない。2回目は拡張の API が返したモデルが候補に載る
    expect(paramKeysOf(first!)).not.toContain('controlnet');
    expect(paramKeysOf(second!)).toContain('controlnet');
    expect(textOf(second!)).toContain('control_v11p_sd15_canny');
    // ControlNet は拡張の欄（alwayson_scripts）として、2回目の txt2img にだけ載る
    const [firstBody, secondBody] = posted(mock, '/sdapi/v1/txt2img');
    expect(firstBody!.alwayson_scripts).toBeUndefined();
    const args = (
      secondBody!.alwayson_scripts as { controlnet: { args: Record<string, unknown>[] } }
    ).controlnet.args;
    expect(args[0]).toMatchObject({
      enabled: true,
      model,
      module: 'canny',
      image: b64(generatedPng(0)),
    });
  });
});
