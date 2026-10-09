import type { MemoryItem } from '../item.js';
import type { MemoryStore } from '../store.js';
import type { DistillEntry } from './log.js';
import type { DistillOperation, DistilledPreference } from './schema.js';

const preferenceOf = (item: DistilledPreference): DistilledPreference => ({
  body: item.body,
  tags: [...item.tags],
  scope: item.scope,
});

/**
 * 蒸留の操作を記憶に反映する。項目を消すことはしない。
 */
// 直す前に、見せた版から変わっていないかを確かめる: 蒸留のあいだに人間が直した・消した項目を、
// AI の古い判断で上書きしたり生き返らせたりしないため
export async function applyDistillOperations(args: {
  store: MemoryStore;
  operations: readonly DistillOperation[];
  shown: readonly MemoryItem[];
  jobId: string;
  now: Date;
  newMemoryId: () => string;
}): Promise<Pick<DistillEntry, 'applied' | 'skipped'>> {
  const { store, operations, jobId, newMemoryId } = args;
  const at = args.now.toISOString();
  const shownById = new Map(args.shown.map((item) => [item.id, item]));
  const applied: DistillEntry['applied'] = [];
  const skipped: DistillEntry['skipped'] = [];
  const edited = new Set<string>();

  for (const operation of operations) {
    if (operation.op === 'add') {
      const id = await unusedId(store, newMemoryId);
      const after = preferenceOf(operation);
      await store.put({ id, ...after, sources: [jobId], createdAt: at, updatedAt: at });
      applied.push({ op: 'add', id, after });
      continue;
    }

    const shown = shownById.get(operation.id);
    const current = await store.get(operation.id);
    if (shown === undefined) {
      skipped.push({ operation, reason: '入力に載せていない項目は直さない' });
    } else if (edited.has(operation.id)) {
      skipped.push({ operation, reason: '同じ蒸留の中で、同じ項目をすでに直した' });
    } else if (current === null) {
      skipped.push({ operation, reason: '蒸留のあいだに人間が消した' });
    } else if (current.updatedAt !== shown.updatedAt) {
      skipped.push({ operation, reason: '蒸留のあいだに項目が直された' });
    } else {
      const after = preferenceOf(operation);
      const sources = current.sources.includes(jobId)
        ? current.sources
        : [...current.sources, jobId];
      await store.put({ ...current, ...after, sources, updatedAt: at });
      applied.push({ op: 'edit', id: current.id, before: preferenceOf(current), after });
      edited.add(current.id);
    }
  }
  return { applied, skipped };
}

const ID_ATTEMPTS = 20;

async function unusedId(store: MemoryStore, newMemoryId: () => string): Promise<string> {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const id = newMemoryId();
    if ((await store.get(id)) === null) return id;
  }
  throw new Error(`記憶の新しい ID が ${ID_ATTEMPTS} 回続けて既存の項目と重なった`);
}
