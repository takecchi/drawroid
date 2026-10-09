import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  generationRequestSchema,
  ManualGenerationRunner,
  type JobSpec,
  type JobState,
  type LlmCallRecord,
} from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { dataPaths, FsJobStore } from '@drawroid/storage-fs';
import sharp from 'sharp';

import { createApi } from './index.js';

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'drawroid-api-'));
  const store = new FsJobStore(root);
  const backend = new StubBackend();
  const api = createApi({
    backend,
    store,
    manualRunner: new ManualGenerationRunner({ backend, store }),
    autoQueue: { kick: () => undefined, stop: async () => undefined },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
  });
  return { root, store, api, paths: dataPaths(root) };
}

export const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

export function createAutoJob(
  store: FsJobStore,
  state: JobState = { status: 'queued' },
): Promise<JobSpec> {
  return store.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺の少女',
      stopConditions: { aiJudgement: true, maxIterations: 5 },
      batchSize: 2,
    },
    state,
    new Date(),
  );
}

export async function png(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
}

export function llmRecord(
  jobId: string,
  callId: string,
  iteration: number | null,
  overrides: Partial<LlmCallRecord> = {},
): LlmCallRecord {
  return {
    callId,
    jobId,
    iteration,
    role: 'think',
    purpose: 'think',
    provider: 'local',
    model: 'qwen',
    startedAt: '2026-10-09T00:00:00.000Z',
    durationMs: 100,
    input: { system: 'SYSTEM-PROMPT', user: [{ type: 'text', text: 'USER-TEXT' }] },
    budget: { estimatedInputTokens: 1, inputTokenLimit: 2, notes: [] },
    attempts: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    outcome: { ok: true, value: { answer: 'OUTCOME-VALUE' } },
    ...overrides,
  };
}
