// config.json を書く口（LLM の設定・許可）に、PUT が同時に来ても、どちらの変更も消えないことを見る試験。
// 置き場所は本物のファイル
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  type ImageBackend,
  type JobStore,
  type ManualGenerationRunner,
  type MemoryStore,
} from '@drawroid/core';
import {
  readLlmSettings,
  readPermissionSettings,
  writeLlmSettings,
  writePermissionSettings,
} from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from './index.js';
import {
  noCandidateNotes,
  memoryBudgetSettings,
  memoryProgressDeps,
  memoryConversations,
} from './test-support.js';

let dir: string;
let configPath: string;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-config-concurrency-'));
  configPath = join(dir, 'config.json');
  app = createApi({
    // 設定の経路はジョブとバックエンドを使わない
    backend: {} as ImageBackend,
    store: {} as JobStore,
    memoryStore: {} as MemoryStore,
    manualRunner: {} as ManualGenerationRunner,
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
      addMask: notUsed,
    },
    budgetSettings: memoryBudgetSettings(),
    ...memoryProgressDeps(),
    stopConditionParser: { parse: notUsed },
    backendSettings: { read: notUsed, write: notUsed },
    llmSettings: {
      read: () => readLlmSettings(configPath),
      write: (config) => writeLlmSettings(configPath, config),
    },
    permissionSettings: {
      base: basicPermissions({ width: 64, height: 64 }),
      read: () => readPermissionSettings(configPath),
      write: (overrides) => writePermissionSettings(configPath, overrides),
    },
    candidateNotes: noCandidateNotes,
    conversations: memoryConversations(),
    env: {},
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function notUsed(): Promise<never> {
  throw new Error('設定の試験では使わない口');
}

const put = (path: string, body: unknown) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const llm = {
  providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
  roles: {
    think: { provider: 'local', model: 'qwen' },
    judge: { provider: 'local', model: 'qwen' },
  },
};
const permissions = { steps: { mode: 'fixed', value: 28 } };

describe('PUTs that write config.json at the same time', () => {
  it('keeps both changes when the LLM settings and the permissions are put at once', async () => {
    const [llmRes, permissionsRes] = await Promise.all([
      put('/settings/llm', llm),
      put('/settings/permissions', permissions),
    ]);

    expect(llmRes.status).toBe(200);
    expect(permissionsRes.status).toBe(200);
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(stored.permissions).toEqual(permissions);
    expect(stored.llm).toMatchObject({ roles: llm.roles });
  });
});
