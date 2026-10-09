// 人間が画面で塗ったマスクで、次の回に inpaint が行われることを、画面と同じ API の呼び方から偽の Forge まで通しで見る試験
// （milestones:124 の、実機で確かめる手前）。LLM は台本どおりに返すスタブ、置き場所は本物のファイル、バックエンドは
// 本物の ForgeBackend を偽の Forge（HTTP）に繋ぐ
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '@drawroid/api';
import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  ManualGenerationRunner,
  type LlmCall,
} from '@drawroid/core';
import { ScriptedLlm, STUB_PNG, type Script } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ForgeBackend } from './forge-backend.js';
import { startMockForge, type MockForge } from './test-support/mock-forge.js';

// 塗ったマスク。生成された画像（STUB_PNG）と見分けられるよう、後ろにバイトを足す（API は PNG の署名だけを見る）
const MASK_PNG = new Uint8Array([...STUB_PNG, 0x6d, 0x61, 0x73, 0x6b]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

let root: string;
let forge: MockForge;
let runner: JobRunner;
let app: ReturnType<typeof createApi>;
let onFirstJudge: () => Promise<void>;

const paramKeysOf = (call: LlmCall<unknown>) => {
  const json = z.toJSONSchema(call.schema) as unknown as {
    properties: { params: { properties?: object } };
  };
  return Object.keys(json.properties.params.properties ?? {});
};

// 考える役は、inpaint が出力スキーマにあれば（＝マスクがある回だけ）、描き直しの強さを決める
const think: Script = (call) => ({
  params: {
    prompt: 'girl, beach, sunset',
    negativePrompt: 'lowres',
    seed: 7,
    steps: 20,
    cfgScale: 6,
    ...(paramKeysOf(call).includes('inpaint') ? { inpaint: { denoisingStrength: 0.6 } } : {}),
  },
  rationale: '案',
});
const judge: Script = async (call, n) => {
  if (n === 0) await onFirstJudge();
  return {
    images: call.messages.user
      .filter((part) => part.type === 'image')
      .map(() => ({ score: 0.5, issues: [] })),
    nextChange: 'なし',
    canStop: false,
  };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-painted-mask-'));
  forge = await startMockForge();
  onFirstJudge = async () => undefined;
  const store = new FsJobStore(root);
  const backend = new ForgeBackend({ baseUrl: forge.url });
  const base = basicPermissions({ width: 512, height: 512 });
  runner = new JobRunner({
    store,
    llm: new ScriptedLlm({ think, judge }),
    backend,
    budget: DEFAULT_BUDGET,
    permissions: base,
  });
  const notUsed = () => Promise.reject(new Error('この試験では使わない'));
  app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(dataPaths(root).memory),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    autoQueue: runner,
    budget: DEFAULT_BUDGET,
    stopConditionParser: { parse: notUsed },
    backendSettings: { read: notUsed, write: notUsed },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    permissionSettings: { base, read: async () => undefined, write: notUsed },
    candidateNotes: { read: async () => ({ notes: new Map() }), write: notUsed },
    env: {},
  });
});

afterEach(async () => {
  await runner.idle();
  await forge.close();
  await rm(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const generations = () =>
  forge.requests
    .filter((r) => r.method === 'POST' && /^\/sdapi\/v1\/(txt2img|img2img)$/.test(r.path))
    .map((r) => ({ path: r.path, body: JSON.parse(r.body) as Record<string, unknown> }));

describe('a mask painted on the screen drives inpaint in the next iteration (milestones:124)', () => {
  it('repaints the painted image with that mask on Forge once, then goes back to txt2img', async () => {
    // 投入の画面と同じ形: このジョブだけ inpaint を AI に任せる（#97）
    const created = await post('/jobs/auto', {
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: false, maxIterations: 3 },
      batchSize: 1,
      permissions: { inpaint: { mode: 'auto' } },
    });
    expect(created.status).toBe(202);
    const { jobId } = (await created.json()) as { jobId: string };

    // 1回目の画像を見ている間に、人間が画面で 1 回目の画像 0 にマスクを塗って送る（swr の addMask と同じ本文）
    let painted: Response | undefined;
    onFirstJudge = async () => {
      painted = await post(`/jobs/auto/${jobId}/interventions`, {
        kind: 'mask',
        image: { iteration: 1, index: 0 },
        mask: { data: base64(MASK_PNG) },
      });
    };
    await runner.idle();

    expect(painted?.status).toBe(202);
    const [first, second, third] = generations();
    expect(first?.path).toBe('/sdapi/v1/txt2img');
    expect(second?.path).toBe('/sdapi/v1/img2img');
    expect(second?.body).toMatchObject({
      // 元画像は塗った画像（1 回目の画像 0）、マスクは塗ったもの、白い所を描き直す
      init_images: [base64(STUB_PNG)],
      mask: base64(MASK_PNG),
      inpainting_mask_invert: 0,
      denoising_strength: 0.6,
    });
    // マスクは1回使うと切れる
    expect(third?.path).toBe('/sdapi/v1/txt2img');
    expect(third?.body).not.toHaveProperty('mask');

    // 口出しの一覧（画面が読む口）に、どの回の inpaint に使ったかが出る
    const listed = (await (await app.request(`/jobs/auto/${jobId}/interventions`)).json()) as {
      interventions: { kind: string; image?: object; usedInIteration?: number }[];
    };
    expect(listed.interventions.filter((i) => i.kind === 'mask')).toEqual([
      expect.objectContaining({ image: { iteration: 1, index: 0 }, usedInIteration: 2 }),
    ]);
  });

  it('does not inpaint at all when no mask is painted', async () => {
    const created = await post('/jobs/auto', {
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: false, maxIterations: 2 },
      batchSize: 1,
      permissions: { inpaint: { mode: 'auto' } },
    });
    expect(created.status).toBe(202);
    await runner.idle();

    expect(generations().map((g) => g.path)).toEqual(['/sdapi/v1/txt2img', '/sdapi/v1/txt2img']);
  });
});
