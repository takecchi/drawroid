// ループ（JobRunner）が、img2img の元画像を見せた画像のキーから選ばせ、塗ったマスクがあるときだけ inpaint を
// 出していることを見る試験（M4 の 4-7b、M4:121）。LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ
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
import { ScriptedLlm, STUB_PNG, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FsJobStore } from './job-store.js';
import { dataPaths } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-image-inputs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const base = basicPermissions({ width: 512, height: 512 });
const decided = {
  prompt: 'girl, beach, sunset',
  negativePrompt: 'lowres',
  seed: 7,
  steps: 20,
  cfgScale: 6,
};

const paramKeysOf = (call: LlmCall<unknown>) => {
  const json = z.toJSONSchema(call.schema) as unknown as {
    properties: { params: { properties?: object } };
  };
  return Object.keys(json.properties.params.properties ?? {}).sort();
};
const textOf = (call: LlmCall<unknown>) =>
  call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** 考える役。出力スキーマにある画像の欄にだけ値を入れる */
function think(choose: { img2img?: string; inpaint?: number } = {}): Script {
  return (call) => {
    const keys = paramKeysOf(call);
    return {
      params: {
        ...decided,
        ...(keys.includes('img2img') && choose.img2img !== undefined
          ? { img2img: { image: choose.img2img, denoisingStrength: 0.5 } }
          : {}),
        ...(keys.includes('inpaint') && choose.inpaint !== undefined
          ? { inpaint: { denoisingStrength: choose.inpaint } }
          : {}),
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

function setup(scripts: ConstructorParameters<typeof ScriptedLlm>[0], permissions: Permissions) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm(scripts);
  const backend = new StubBackend();
  const runner = new JobRunner({ store, llm, backend, budget: DEFAULT_BUDGET, permissions });
  return { store, llm, backend, runner };
}

async function submit(store: FsJobStore, maxIterations: number): Promise<AutoJobSpec> {
  const request = '夕暮れの海辺に立つ少女、アニメ調';
  const spec = await store.createJob(
    {
      kind: 'auto',
      request,
      stopConditions: { aiJudgement: false, maxIterations },
      batchSize: 1,
    },
    { status: 'queued', carry: { intent: request, completedIterations: 0 } },
    new Date(),
  );
  if (spec.kind !== 'auto') throw new Error('auto のはず');
  return spec;
}

const thinkCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.purpose === 'think');

describe('inpaint follows the mask the human painted (M4:121)', () => {
  const permissions = mergePermissions(base, { inpaint: { mode: 'auto' } });

  it('does not offer inpaint while there is no mask, and goes on without waiting for one', async () => {
    const { store, llm, backend, runner } = setup(
      { think: think({ inpaint: 0.6 }), judge: judge() },
      permissions,
    );
    const spec = await submit(store, 3);

    runner.kick();
    await runner.idle();

    expect(await store.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'limit:iterations' },
    });
    expect(thinkCalls(llm)).toHaveLength(3);
    for (const call of thinkCalls(llm)) expect(paramKeysOf(call)).not.toContain('inpaint');
    expect(backend.requests.every((request) => request.inpaint === undefined)).toBe(true);
  });

  it('goes on without a mask even when ControlNet is left to the AI too', async () => {
    const { store, llm, backend, runner } = setup(
      { think: think({ inpaint: 0.6 }), judge: judge() },
      mergePermissions(permissions, { controlnet: { mode: 'auto' } }),
    );
    const spec = await submit(store, 3);

    runner.kick();
    await runner.idle();

    expect(await store.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'limit:iterations' },
    });
    expect(thinkCalls(llm)).toHaveLength(3);
    expect(backend.requests.every((request) => request.inpaint === undefined)).toBe(true);
  });

  it('repaints the painted image with the mask once it arrives, then lets the mask go', async () => {
    let jobId = '';
    const set = setup(
      {
        think: think({ inpaint: 0.6 }),
        // 1回目を見ている間に、人間が1回目の画像にマスクを塗る
        judge: judge(async (n) => {
          if (n === 0) {
            await set.runner.addMask(jobId, {
              image: { iteration: 1, index: 0 },
              data: STUB_PNG,
            });
          }
        }),
      },
      permissions,
    );
    const spec = await submit(set.store, 3);
    jobId = spec.jobId;

    set.runner.kick();
    await set.runner.idle();

    const [first, second, third] = thinkCalls(set.llm);
    expect(paramKeysOf(first!)).not.toContain('inpaint');
    expect(paramKeysOf(second!)).toContain('inpaint');
    expect(paramKeysOf(third!)).not.toContain('inpaint');
    const [mask] = (await set.store.listInterventions(spec.jobId)).filter((i) => i.kind === 'mask');
    expect(set.backend.requests[1]?.inpaint).toMatchObject({
      image: 'image:1-0',
      mask: `mask:${mask!.interventionId}`,
      denoisingStrength: 0.6,
    });
    expect(set.backend.requests[2]?.inpaint).toBeUndefined();
    expect(mask).toMatchObject({ usedInIteration: 2 });
  });

  it('does not offer inpaint for a mask whose image was never written, and goes on', async () => {
    let jobId = '';
    const set = setup(
      {
        think: think({ inpaint: 0.6 }),
        // マスクの記録だけが置かれて、PNG は置かれないまま落ちた跡
        judge: judge(async (n) => {
          if (n === 0) {
            const mask = await set.store.addMask(
              jobId,
              { image: { iteration: 1, index: 0 }, data: STUB_PNG },
              new Date(),
            );
            await rm(dataPaths(root).jobFiles(jobId).mask(mask.interventionId));
          }
        }),
      },
      permissions,
    );
    const spec = await submit(set.store, 3);
    jobId = spec.jobId;

    set.runner.kick();
    await set.runner.idle();

    expect(await set.store.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'limit:iterations' },
    });
    for (const call of thinkCalls(set.llm)) expect(paramKeysOf(call)).not.toContain('inpaint');
    expect(set.backend.requests.every((request) => request.inpaint === undefined)).toBe(true);
  });

  it('uses only the newest mask when the human paints again before it is used', async () => {
    let jobId = '';
    const set = setup(
      {
        think: think({ inpaint: 0.6 }),
        judge: judge(async (n) => {
          if (n === 0) {
            await set.runner.addMask(jobId, { image: { iteration: 1, index: 0 }, data: STUB_PNG });
            await set.runner.addMask(jobId, { image: { iteration: 1, index: 0 }, data: STUB_PNG });
          }
        }),
      },
      permissions,
    );
    const spec = await submit(set.store, 3);
    jobId = spec.jobId;

    set.runner.kick();
    await set.runner.idle();

    const masks = (await set.store.listInterventions(spec.jobId)).filter((i) => i.kind === 'mask');
    expect(set.backend.requests[1]?.inpaint?.mask).toBe(`mask:${masks[1]!.interventionId}`);
    expect(set.backend.requests.filter((r) => r.inpaint !== undefined)).toHaveLength(1);
  });
});

describe('image source keys are shown only when img2img is left to the AI (Issue #5 G)', () => {
  it('shows no source image keys to the thinking role while img2img is not allowed', async () => {
    const { store, llm, runner } = setup({ think: think(), judge: judge() }, base);
    await submit(store, 3);

    runner.kick();
    await runner.idle();

    const calls = thinkCalls(llm);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(paramKeysOf(call)).not.toContain('img2img');
      expect(textOf(call)).not.toContain('元画像のキー');
    }
    // 最良は載っている。キーだけが無い
    expect(textOf(calls[1]!)).toContain('最良');
  });
});

describe('img2img starts from an image the thinking role was shown (Issue #5 G)', () => {
  const permissions = mergePermissions(base, { img2img: { mode: 'auto' } });

  it('lets the AI start from the best image so far, sending that image to the backend', async () => {
    const { store, llm, backend, runner } = setup(
      { think: think({ img2img: 'best' }), judge: judge() },
      permissions,
    );
    await submit(store, 2);

    runner.kick();
    await runner.idle();

    const [first, second] = thinkCalls(llm);
    expect(paramKeysOf(first!)).not.toContain('img2img');
    expect(paramKeysOf(second!)).toContain('img2img');
    expect(textOf(second!)).toContain('最良（元画像のキー best）');
    // スタブのバックエンドは、参照の中身が渡されていなければ失敗する
    expect(backend.requests[1]?.img2img).toMatchObject({
      image: 'image:1-0',
      denoisingStrength: 0.5,
    });
  });

  it('lets the AI start from a reference image the human added (M4:123)', async () => {
    // 参照画像の refId は置いてから決まるので、考える役が選ぶキーはあとから入れる
    const choice: { img2img?: string } = {};
    const { store, llm, backend, runner } = setup(
      {
        think: think(choice),
        judge: judge(),
        'ref-gist': () => ({ gist: '白いワンピースの立ち姿' }),
      },
      permissions,
    );
    const spec = await submit(store, 1);
    const reference = await store.addReference(
      spec.jobId,
      { data: STUB_PNG, mediaType: 'image/png', note: 'この立ち姿で' },
      new Date(),
    );
    choice.img2img = `ref:${reference.refId}`;

    runner.kick();
    await runner.idle();

    expect(textOf(thinkCalls(llm)[0]!)).toContain(`ref:${reference.refId}: 白いワンピースの立ち姿`);
    expect(backend.requests[0]?.img2img).toMatchObject({ image: `ref:${reference.refId}` });
  });
});
