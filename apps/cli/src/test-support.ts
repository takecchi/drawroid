import { DEFAULT_BUDGET, ManualGenerationRunner } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import type { ApiDeps } from '@drawroid/api';
import { createFsMemoryStore, FsJobStore } from '@drawroid/storage-fs';

// サーバの試験が、実際のバックエンドを使わずに API を組み立てるための部品。置き場所はデータディレクトリの外の一時の場所でよい: 試験は保存を使わない
export function stubDeps(root = '/nonexistent-drawroid-test-root'): ApiDeps {
  const backend = new StubBackend();
  const store = new FsJobStore(root);
  return {
    backend,
    store,
    memoryStore: createFsMemoryStore(`${root}/memory`),
    manualRunner: new ManualGenerationRunner({ backend, store }),
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
    budget: DEFAULT_BUDGET,
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
  };
}

async function notUsed(): Promise<never> {
  throw new Error('サーバの試験では使わない口');
}
