import { describe, expect, it } from 'vitest';

import { type MemoryItem, memoryItemSchema } from './item.js';
import { selectMemory } from './select.js';

function item(overrides: Partial<MemoryItem> & Pick<MemoryItem, 'id'>): MemoryItem {
  return {
    body: `好み ${overrides.id}`,
    tags: [],
    scope: 'tagged',
    sources: ['20261009-153012-k3f9'],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const roomy = { maxItems: 100, maxChars: 10_000 };
const ids = (items: readonly MemoryItem[]) => items.map((i) => i.id);

describe('selectMemory', () => {
  it('always passes items whose scope is always, even when no tag matches the request', () => {
    const items = [item({ id: 'fingers', body: '指の崩れは許容しない', scope: 'always' })];

    const { selected } = selectMemory(items, '夕暮れの海辺に立つ少女', roomy);

    expect(ids(selected)).toEqual(['fingers']);
  });

  it('passes tagged items only when one of their tags appears in the request gist', () => {
    const items = [item({ id: 'anime', tags: ['アニメ'] }), item({ id: 'photo', tags: ['実写'] })];

    const { selected } = selectMemory(items, 'アニメ調の少女', roomy);

    expect(ids(selected)).toEqual(['anime']);
  });

  it('matches tags regardless of letter case and full-width forms', () => {
    const items = [item({ id: 'anime', tags: ['Anime'] })];

    const { selected } = selectMemory(items, 'ＡＮＩＭＥ style girl', roomy);

    expect(ids(selected)).toEqual(['anime']);
  });

  it('orders always items first, then by number of matched tags, then by most recently updated', () => {
    const items = [
      item({ id: 'one-tag-new', tags: ['海'], updatedAt: '2026-10-09T00:00:00Z' }),
      item({ id: 'one-tag-old', tags: ['海'], updatedAt: '2026-10-02T00:00:00Z' }),
      item({ id: 'two-tags', tags: ['海', '夕暮れ'] }),
      item({ id: 'always', scope: 'always' }),
    ];

    const { selected } = selectMemory(items, '夕暮れの海', roomy);

    expect(ids(selected)).toEqual(['always', 'two-tags', 'one-tag-new', 'one-tag-old']);
  });

  it('keeps the passed amount within the budget even with hundreds of items', () => {
    const items = Array.from({ length: 500 }, (_, n) =>
      item({
        id: `m${String(n).padStart(3, '0')}`,
        body: `好みの項目 ${n} `.repeat(3),
        scope: 'always',
      }),
    );
    const budget = { maxItems: 20, maxChars: 400 };

    const { selected } = selectMemory(items, '少女', budget);

    expect(selected.length).toBeLessThanOrEqual(budget.maxItems);
    expect(selected.reduce((sum, i) => sum + i.body.length, 0)).toBeLessThanOrEqual(
      budget.maxChars,
    );
  });

  it('reports every relevant item it left out because of the budget', () => {
    const items = Array.from({ length: 300 }, (_, n) =>
      item({ id: `m${String(n).padStart(3, '0')}`, scope: 'always' }),
    );

    const { selected, droppedByBudget } = selectMemory(items, '少女', {
      maxItems: 10,
      maxChars: 10_000,
    });

    expect(selected).toHaveLength(10);
    expect(droppedByBudget).toHaveLength(290);
    expect(new Set([...ids(selected), ...ids(droppedByBudget)]).size).toBe(300);
  });

  it('does not report unrelated items as dropped', () => {
    const items = [item({ id: 'photo', tags: ['実写'] })];

    const { selected, droppedByBudget } = selectMemory(items, 'アニメ調', roomy);

    expect(selected).toEqual([]);
    expect(droppedByBudget).toEqual([]);
  });

  it('still passes shorter lower-ranked items when a longer one does not fit', () => {
    const items = [
      item({
        id: 'long',
        body: 'あ'.repeat(50),
        scope: 'always',
        updatedAt: '2026-10-09T00:00:00Z',
      }),
      item({ id: 'short', body: 'い'.repeat(5), scope: 'always' }),
    ];

    const { selected, droppedByBudget } = selectMemory(items, '', { maxItems: 10, maxChars: 10 });

    expect(ids(selected)).toEqual(['short']);
    expect(ids(droppedByBudget)).toEqual(['long']);
  });

  it('uses the packing function it is given, so the shared packer can replace the default', () => {
    const items = [item({ id: 'a', scope: 'always' }), item({ id: 'b', scope: 'always' })];
    const keepNothing = <T>(all: readonly T[]) => ({ kept: [], dropped: [...all] });

    const { selected, droppedByBudget } = selectMemory(items, '', roomy, keepNothing);

    expect(selected).toEqual([]);
    expect(ids(droppedByBudget)).toEqual(['a', 'b']);
  });
});

describe('memoryItemSchema', () => {
  it('accepts an item as it is written in the memory file and fills empty lists', () => {
    const parsed = memoryItemSchema.parse({
      id: 'fingers',
      body: '指の崩れは許容しない',
      scope: 'always',
      createdAt: '2026-10-09T15:40:00+09:00',
      updatedAt: '2026-10-09T15:40:00+09:00',
    });

    expect(parsed.tags).toEqual([]);
    expect(parsed.sources).toEqual([]);
  });

  it('rejects an item whose scope is not one it knows', () => {
    const result = memoryItemSchema.safeParse({ ...item({ id: 'x' }), scope: 'sometimes' });

    expect(result.success).toBe(false);
  });
});
