import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  ConversationHubs,
  generationRequestSchema,
  ManualGenerationRunner,
  resolveBudgets,
  type BudgetOverrides,
  type JobSpec,
  type JobState,
  type LlmCallRecord,
} from '@drawroid/core';
import { MemoryConversationStore, StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import sharp from 'sharp';

import type {
  BudgetSettingsPort,
  CandidateNotesStore,
  ConversationsPort,
  PermissionSettingsStore,
} from './deps.js';
import { createApi } from './index.js';

/** 許可の設定を使わない試験のための、何も書かれていない置き場所 */
export const noPermissionSettings: PermissionSettingsStore = {
  base: basicPermissions({ width: 64, height: 64 }),
  read: async () => undefined,
  write: async () => undefined,
};

/** 書いた予算をメモリに持つ置き場所。config.json を使わない試験のため */
export function memoryBudgetSettings(initial: BudgetOverrides = {}): BudgetSettingsPort {
  let overrides = initial;
  return {
    read: async () => ({ overrides, effective: resolveBudgets(overrides) }),
    write: async (next) => {
      overrides = next;
      return resolveBudgets(next);
    },
  };
}

/** 会話をメモリに置く。会話を使わない試験でも、createApi の依存として渡す */
export function memoryConversations(): ConversationsPort {
  const store = new MemoryConversationStore();
  return { store, hubs: new ConversationHubs({ store }) };
}

/** 候補の説明を使わない試験のための、何も書かれていない置き場所 */
export const noCandidateNotes: CandidateNotesStore = {
  read: async () => ({ notes: new Map() }),
  write: async () => undefined,
};

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'drawroid-api-'));
  const store = new FsJobStore(root);
  const backend = new StubBackend();
  const budgetSettings = memoryBudgetSettings();
  const api = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(dataPaths(root).memory),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
      addMask: notUsed,
    },
    budgetSettings,
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    conversations: memoryConversations(),
    env: {},
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
  });
  return { root, store, api, paths: dataPaths(root), budgetSettings };
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

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
