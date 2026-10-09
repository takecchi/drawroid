import {
  basicPermissions,
  ConversationHubs,
  DEFAULT_BUDGETS,
  ManualGenerationRunner,
} from '@drawroid/core';
import { MemoryConversationStore, StubBackend } from '@drawroid/core/testing';
import type { ApiDeps } from '@drawroid/api';
import { createFsMemoryStore, FsJobStore } from '@drawroid/storage-fs';

// サーバの試験が、実際のバックエンドを使わずに API を組み立てるための部品。置き場所はデータディレクトリの外の一時の場所でよい: 試験は保存を使わない
export function stubDeps(root = '/nonexistent-drawroid-test-root'): ApiDeps {
  const backend = new StubBackend();
  const store = new FsJobStore(root);
  const conversationStore = new MemoryConversationStore();
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
    budgetSettings: {
      read: async () => ({ overrides: {}, effective: DEFAULT_BUDGETS }),
      write: async () => DEFAULT_BUDGETS,
    },
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    permissionSettings: {
      base: basicPermissions({ width: 64, height: 64 }),
      read: async () => undefined,
      write: async () => undefined,
    },
    candidateNotes: { read: async () => ({ notes: new Map() }), write: async () => undefined },
    conversations: {
      store: conversationStore,
      hubs: new ConversationHubs({ store: conversationStore }),
    },
    env: {},
  };
}

async function notUsed(): Promise<never> {
  throw new Error('サーバの試験では使わない口');
}
