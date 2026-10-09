// 人間が candidate-notes.json に書いた候補の説明が、ループの「考える」の入力に予算の内で載ることを見る試験（Issue #47）。
// LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ。説明は本物のファイルから読む
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  mergePermissions,
  type Candidate,
  type LlmCall,
  type PackLimits,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCandidateNotes } from './candidate-notes.js';
import { FsJobStore } from './job-store.js';
import { dataPaths } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-candidate-notes-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const permissions = mergePermissions(basicPermissions({ width: 512, height: 512 }), {
  loras: { mode: 'auto' },
});

const think: Script = () => ({
  params: {
    prompt: 'girl, beach, sunset',
    negativePrompt: 'lowres',
    seed: 7,
    steps: 20,
    cfgScale: 6,
    loras: [],
  },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.9, issues: [] })),
  nextChange: 'なし',
  canStop: true,
});

async function runWith(options: { loras: Candidate[]; candidateLimits?: PackLimits }) {
  const store = new FsJobStore(root);
  const llm = new ScriptedLlm({ think, judge });
  const backend = new StubBackend({ candidates: { lora: options.loras } });
  const runner = new JobRunner({
    store,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    permissions,
    candidateNotes: () => readCandidateNotes(dataPaths(root).candidateNotes),
    ...(options.candidateLimits === undefined ? {} : { candidateLimits: options.candidateLimits }),
  });
  const request = '夕暮れの海辺に立つ少女';
  const spec = await store.createJob(
    {
      kind: 'auto',
      request,
      stopConditions: { aiJudgement: true, maxIterations: 1 },
      batchSize: 1,
    },
    { status: 'queued', carry: { intent: request, completedIterations: 0 } },
    new Date(),
  );
  runner.kick();
  await runner.idle();
  const call = llm.calls.find((c) => c.purpose === 'think');
  return { store, backend, spec, call };
}

const textOf = (call: LlmCall<unknown> | undefined) =>
  (call?.messages.user ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
const writeNotes = (content: string) => writeFile(dataPaths(root).candidateNotes, content);

describe('the notes a human wrote on candidates reach the thinking role (Issue #47)', () => {
  it('puts the note next to the candidate in the input of the thinking role', async () => {
    await writeNotes(JSON.stringify({ watercolor_v2: '水彩の滲み。重みは 0.6 まで' }));

    const { call } = await runWith({ loras: [{ name: 'watercolor_v2' }, { name: 'detail' }] });

    expect(textOf(call)).toContain('watercolor_v2（水彩の滲み。重みは 0.6 まで）');
  });

  it('reads the notes again for each job, so an edit takes effect without a restart', async () => {
    await writeNotes(JSON.stringify({ watercolor_v2: '古い説明' }));
    await runWith({ loras: [{ name: 'watercolor_v2' }] });
    await writeNotes(JSON.stringify({ watercolor_v2: '新しい説明' }));

    const { call } = await runWith({ loras: [{ name: 'watercolor_v2' }] });

    expect(textOf(call)).toContain('watercolor_v2（新しい説明）');
  });

  it('goes on without notes when the file is broken, recording why in the record of the call', async () => {
    await writeNotes('{ "watercolor_v2": ');

    const { call, backend } = await runWith({ loras: [{ name: 'watercolor_v2' }] });

    expect(textOf(call)).toContain('watercolor_v2');
    expect(textOf(call)).not.toContain('watercolor_v2（');
    expect(call?.messages.report.notes).toContainEqual(
      expect.objectContaining({
        kind: 'dropped',
        section: 'candidateNotes',
        reason: expect.stringContaining('candidate-notes.json') as unknown,
      }),
    );
    expect(backend.requests).toHaveLength(1);
  });

  it('keeps the input within the budget with hundreds of noted LoRAs, recording the notes left out', async () => {
    const loras = Array.from({ length: 300 }, (_, n) => ({
      name: `lora-${String(n).padStart(3, '0')}`,
    }));
    await writeNotes(
      JSON.stringify(Object.fromEntries(loras.map((l) => [l.name, '説明'.repeat(20)]))),
    );

    const { call } = await runWith({ loras, candidateLimits: { maxCount: 10, maxSize: 300 } });

    const report = call!.messages.report;
    expect(report.estimatedInputTokens).toBeLessThanOrEqual(report.inputTokenLimit);
    const shownNotes = (textOf(call).match(/（説明/g) ?? []).length;
    const droppedNotes = report.notes.filter(
      (n) => n.section.startsWith('candidates.lora[') && n.section.endsWith('].note'),
    );
    expect(shownNotes).toBeGreaterThan(0);
    expect(droppedNotes.length).toBeGreaterThan(0);
    // 見せた候補 10 個の説明は、載せたものと落としたものとで、ちょうど 10 個になる
    expect(shownNotes + droppedNotes.length).toBe(10);
  });
});
