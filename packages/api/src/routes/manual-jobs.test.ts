import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generationRequestSchema, ManualGenerationRunner } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';
import {
  noCandidateNotes,
  noPermissionSettings,
  memoryBudgetSettings,
  memoryProgressDeps,
  memoryConversations,
} from '../test-support.js';

let root: string;
let store: FsJobStore;
let autoStops: string[];
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-manual-'));
  store = new FsJobStore(root);
  autoStops = [];
  const backend = new StubBackend();
  app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(join(root, 'memory')),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    autoQueue: {
      kick: () => undefined,
      stop: async (jobId) => void autoStops.push(jobId),
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
      addMask: notUsed,
    },
    budgetSettings: memoryBudgetSettings(),
    ...memoryProgressDeps(),
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    conversations: memoryConversations(),
    env: {},
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

// 走らせずに待っている手動のジョブを置く: 止める口が、置き場所の上で待っているジョブを止めることを見るため
async function waitingManual(): Promise<string> {
  return (await store.createJob({ kind: 'manual', request }, { status: 'queued' }, new Date()))
    .jobId;
}

async function autoJob(): Promise<string> {
  return (
    await store.createJob(
      {
        kind: 'auto',
        request: '夕暮れの海辺',
        stopConditions: { aiJudgement: true, maxIterations: 10 },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: '夕暮れの海辺', completedIterations: 0 } },
      new Date(),
    )
  ).jobId;
}

describe('POST /jobs/manual/:jobId/stop', () => {
  it('stops the manual job as a human stop and answers 202', async () => {
    const jobId = await waitingManual();
    const res = await app.request(`/jobs/manual/${jobId}/stop`, { method: 'POST' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId });
    expect(await store.readState(jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'human' },
    });
  });

  it.each([
    ['an unknown job', async () => '20260101-000000-zzzz'],
    ['a path-like id', async () => '..%2F..'],
    ['an automatic job', autoJob],
  ])('answers 404 without stopping anything for %s', async (_name, idOf) => {
    const jobId = await idOf();
    const res = await app.request(`/jobs/manual/${jobId}/stop`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { kind: 'not_found' } });
    expect(autoStops).toEqual([]);
    if ((await store.listJobIds()).includes(jobId)) {
      expect((await store.readState(jobId)).status).toBe('queued');
    }
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
