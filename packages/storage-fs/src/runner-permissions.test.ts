// ループ（JobRunner）が、M4 の許可・候補・出力スキーマ・「固定」の適用を、回ごとに当てていることを見る試験。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ
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
  type PackLimits,
  type Permissions,
} from '@drawroid/core';
import {
  ScriptedLlm,
  StubBackend,
  type Script,
  type StubBackendOptions,
} from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-permissions-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const base = basicPermissions({ width: 512, height: 512 });

const decided = {
  prompt: 'girl, beach, sunset',
  negativePrompt: 'lowres',
  seed: 7,
  steps: 50,
  cfgScale: 6,
};

function thinkWith(extra: Record<string, unknown> = {}): Script {
  return () => ({ params: { ...decided, ...extra }, rationale: '案' });
}

const judgeOnce: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.9, issues: [] })),
  nextChange: 'なし',
  canStop: true,
});

function setup(options: {
  think: Script;
  permissions?: Permissions;
  backend?: StubBackendOptions;
  candidateLimits?: PackLimits;
}) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm({ think: options.think, judge: judgeOnce });
  const backend = new StubBackend(options.backend);
  const runner = new JobRunner({
    store,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    permissions: options.permissions ?? base,
    ...(options.candidateLimits === undefined ? {} : { candidateLimits: options.candidateLimits }),
  });
  return { store, llm, backend, runner };
}

async function runOne(
  store: FsJobStore,
  runner: JobRunner,
  permissions?: AutoJobSpec['permissions'],
) {
  const request = '夕暮れの海辺に立つ少女、アニメ調';
  const spec = await store.createJob(
    {
      kind: 'auto',
      request,
      stopConditions: { aiJudgement: true, maxIterations: 1 },
      batchSize: 1,
      ...(permissions === undefined ? {} : { permissions }),
    },
    { status: 'queued', carry: { intent: request, completedIterations: 0 } },
    new Date(),
  );
  runner.kick();
  await runner.idle();
  return spec;
}

const thinkCall = (llm: ScriptedLlm) => {
  const call = llm.calls.find((c) => c.purpose === 'think');
  if (call === undefined) throw new Error('考える役が呼ばれていない');
  return call;
};
const textOf = (call: LlmCall<unknown>) =>
  call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('');
const paramKeysOf = (call: LlmCall<unknown>) => {
  const json = z.toJSONSchema(call.schema) as unknown as {
    properties: { params: { properties?: object } };
  };
  return Object.keys(json.properties.params.properties ?? {}).sort();
};

describe('the loop applies the permissions of the job', () => {
  it('lets the thinking role pick a checkpoint only among the candidates it was shown', async () => {
    const permissions = mergePermissions(base, {
      checkpoint: { mode: 'auto', choices: ['stub-real'] },
    });
    const { store, llm, backend, runner } = setup({
      think: thinkWith({ checkpoint: 'stub-real' }),
      permissions,
    });

    await runOne(store, runner);

    const text = textOf(thinkCall(llm));
    expect(text).toContain('チェックポイントの候補: stub-real');
    expect(text).not.toContain('stub-anime');
    expect(backend.requests[0]?.checkpoint).toBe('stub-real');
  });

  it('stops the job instead of generating with a checkpoint the AI was not shown', async () => {
    const permissions = mergePermissions(base, {
      checkpoint: { mode: 'auto', choices: ['stub-real'] },
    });
    const { store, backend, runner } = setup({
      think: thinkWith({ checkpoint: 'stub-anime.safetensors' }),
      permissions,
    });

    const spec = await runOne(store, runner);

    expect(await store.readState(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'error' },
    });
    expect(backend.requests).toEqual([]);
  });

  it('generates with the value the job fixed, whatever the AI returned (M4:118)', async () => {
    const { store, llm, backend, runner } = setup({ think: thinkWith({ steps: 50 }) });

    await runOne(store, runner, { steps: { mode: 'fixed', value: 28 } });

    expect(paramKeysOf(thinkCall(llm))).not.toContain('steps');
    expect(backend.requests[0]).toMatchObject({ steps: 28, cfgScale: 6, width: 512 });
  });

  it('leaves a feature the backend cannot use out of the choices, without asking for its candidates', async () => {
    const permissions = mergePermissions(base, { hiresFix: { mode: 'auto' } });
    const { store, llm, runner } = setup({
      think: thinkWith(),
      permissions,
      backend: {
        capabilities: { unavailable: [{ feature: 'hiresFix', reason: 'このバックエンドに無い' }] },
      },
    });

    await runOne(store, runner);

    expect(paramKeysOf(thinkCall(llm))).not.toContain('hiresFix');
    expect(textOf(thinkCall(llm))).not.toContain('Hires. fix の拡大の方式の候補');
  });

  it('offers Hires. fix with the upscalers the backend lists when it is allowed', async () => {
    const permissions = mergePermissions(base, { hiresFix: { mode: 'auto' } });
    const hires = { upscaler: 'Latent', scale: 1.5, steps: 0, denoisingStrength: 0.5 };
    const { store, llm, backend, runner } = setup({
      think: thinkWith({ hiresFix: hires }),
      permissions,
    });

    await runOne(store, runner);

    expect(paramKeysOf(thinkCall(llm))).toContain('hiresFix');
    expect(backend.requests[0]?.hiresFix).toEqual(hires);
  });

  it('keeps the LoRA list within the budget with hundreds of LoRAs, recording the ones left out (M4:119)', async () => {
    const loras = Array.from({ length: 500 }, (_, n) => ({
      name: `lora-${String(n).padStart(3, '0')}`,
    }));
    const permissions = mergePermissions(base, { loras: { mode: 'auto' } });
    const { store, llm, runner } = setup({
      think: thinkWith({ loras: [{ name: 'lora-000', weight: 0.7 }] }),
      permissions,
      backend: { candidates: { lora: loras } },
      candidateLimits: { maxCount: 10, maxSize: 300 },
    });

    await runOne(store, runner);

    const { report } = thinkCall(llm).messages;
    expect(report.estimatedInputTokens).toBeLessThanOrEqual(report.inputTokenLimit);
    const dropped = report.notes.filter((n) => n.section.startsWith('candidates.lora['));
    expect(dropped).toHaveLength(490);
  });

  it('keeps the LoRA list within 20 names and 600 characters when no limits are given (M4:119)', async () => {
    const loras = Array.from({ length: 500 }, (_, n) => ({
      name: `lora-${String(n).padStart(3, '0')}`,
    }));
    const permissions = mergePermissions(base, { loras: { mode: 'auto' } });
    const { store, llm, runner } = setup({
      think: thinkWith({ loras: [{ name: 'lora-000', weight: 0.7 }] }),
      permissions,
      backend: { candidates: { lora: loras } },
    });

    await runOne(store, runner);

    const line = textOf(thinkCall(llm))
      .split('\n')
      .find((l) => l.startsWith('LoRAの候補'));
    expect(line).toBeDefined();
    const shown = line!.match(/lora-\d{3}/g) ?? [];
    expect(shown.length).toBeLessThanOrEqual(20);
    expect([...line!].length).toBeLessThanOrEqual(600);
    const { report } = thinkCall(llm).messages;
    const dropped = report.notes.filter((n) => n.section.startsWith('candidates.lora['));
    expect(dropped.length).toBe(500 - shown.length);
  });
});
