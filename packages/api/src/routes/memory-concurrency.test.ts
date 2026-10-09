// 記憶の編集（PUT /memory/:id）と蒸留の書き込みが同じ項目に同時に来ても、どちらかの内容が黙って消えないことを見る試験（Issue #44）。
// 置き場所は本物のファイル
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyDistillOperations,
  ManualGenerationRunner,
  type MemoryItem,
  type MemoryStore,
} from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
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
let memoryDir: string;
let store: MemoryStore;
let api: ReturnType<typeof createApi>;

/**
 * 読んだ値を、少し遅れて返すストア。読んでから書くまでのあいだに、別の書き手が書く隙間を毎回作るため
 */
function slowToAnswerReads(inner: MemoryStore): MemoryStore {
  return {
    ...inner,
    list: () => inner.list(),
    put: (item) => inner.put(item),
    remove: (id) => inner.remove(id),
    update: (id, change) => inner.update(id, change),
    async get(id) {
      const item = await inner.get(id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return item;
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-memory-concurrency-'));
  memoryDir = dataPaths(root).memory;
  store = slowToAnswerReads(createFsMemoryStore(memoryDir));
  const jobs = new FsJobStore(root);
  const backend = new StubBackend();
  api = createApi({
    backend,
    store: jobs,
    memoryStore: store,
    manualRunner: new ManualGenerationRunner({ backend, store: jobs }),
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
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
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    conversations: memoryConversations(),
    env: {},
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const item: MemoryItem = {
  id: 'no-broken-fingers',
  body: '指の崩れは許容しない',
  tags: ['hands'],
  scope: 'always',
  sources: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

async function putItemFile() {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    join(memoryDir, `${item.id}.md`),
    `---\ntags: [${item.tags.join(', ')}]\nscope: ${item.scope}\nsources: []\ncreatedAt: ${item.createdAt}\nupdatedAt: ${item.updatedAt}\n---\n${item.body}\n`,
  );
}

describe('editing a preference while the distiller writes it', () => {
  it('keeps what the distiller wrote and answers 409 to the edit, instead of overwriting it', async () => {
    await putItemFile();

    const [distilled, res] = await Promise.all([
      applyDistillOperations({
        store,
        operations: [
          {
            op: 'edit',
            id: item.id,
            body: '指と手の崩れは許容しない',
            tags: ['hands'],
            scope: 'always',
          },
        ],
        shown: [item],
        jobId: '20261009-153012-k3f9',
        now: new Date('2026-10-09T16:00:00Z'),
        newMemoryId: () => 'unused',
      }),
      api.request(`/memory/${item.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: '手の崩れは許容しない',
          tags: ['hands'],
          scope: 'always',
          expectedUpdatedAt: item.updatedAt,
        }),
      }),
    ]);

    expect(distilled.applied).toHaveLength(1);
    expect(res.status).toBe(409);
    expect((await store.get(item.id))?.body).toBe('指と手の崩れは許容しない');
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
