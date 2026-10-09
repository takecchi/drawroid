import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  basicPermissions,
  JobRunner,
  ManualGenerationRunner,
  type LlmCall,
} from '@drawroid/core';
import { ScriptedLlm, STUB_PNG, StubBackend, type Script } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from './index.js';
import {
  noCandidateNotes,
  noPermissionSettings,
  memoryBudgetSettings,
  memoryProgressDeps,
  memoryConversations,
} from './test-support.js';

const GIST = '白いワンピースの裾が風になびく構図';

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 1, steps: 20, cfgScale: 7 },
  rationale: '1 回目の案',
});
const judge: Script = (call: LlmCall<unknown>) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});
const refGist: Script = () => ({ gist: GIST });

/**
 * ジョブを作った直後にランナーへ知らせ、参照画像を置くのに時間が掛かる置き場所。
 * ランナーが、参照画像が置き終わる前にジョブを拾う並びを、毎回起こすため
 */
class EagerStore extends FsJobStore {
  onCreated: () => void = () => undefined;

  override async createJob(...args: Parameters<FsJobStore['createJob']>) {
    const spec = await super.createJob(...args);
    this.onCreated();
    return spec;
  }

  override async addReference(...args: Parameters<FsJobStore['addReference']>) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return super.addReference(...args);
  }
}

let root: string;
let runner: JobRunner;
let llm: ScriptedLlm;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-submission-refs-'));
  const store = new EagerStore(root);
  const backend = new StubBackend();
  llm = new ScriptedLlm({ think, judge, 'ref-gist': refGist });
  runner = new JobRunner({
    store,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
  });
  store.onCreated = () => runner.kick();
  app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(dataPaths(root).memory),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    autoQueue: runner,
    budgetSettings: memoryBudgetSettings(),
    ...memoryProgressDeps(),
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    conversations: memoryConversations(),
    env: {},
  });
});
afterEach(async () => {
  await runner.idle();
  await rm(root, { recursive: true, force: true });
});

describe('reference images attached at submission', () => {
  it('are turned into their gist before the first think, even if the runner picks the job at once', async () => {
    const image = Buffer.from(STUB_PNG);

    const res = await app.request('/jobs/auto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: '夕暮れの海辺の少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        references: [{ mediaType: 'image/png', data: image.toString('base64') }],
      }),
    });
    expect(res.status).toBe(202);
    await runner.idle();

    expect(llm.calls.map((call) => call.purpose)).toEqual(['ref-gist', 'think', 'judge']);
    const firstThink = llm.calls[1]!.messages.user.map((p) => (p.type === 'text' ? p.text : ''));
    expect(firstThink.join('\n')).toContain(GIST);
  });
});
