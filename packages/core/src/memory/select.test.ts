import { describe, expect, it } from 'vitest';

import { type MemoryItem, memoryItemSchema } from './item.js';
import { DEFAULT_MEMORY_LIMITS } from './limits.js';
import { describeMemoryDrop, selectMemory } from './select.js';

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

const roomy = { maxCount: 100, maxSize: 10_000 };
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

  it.each([
    { tag: 'ねこ', gist: 'ネコ耳の少女' },
    { tag: 'ネコ', gist: 'ねこ耳の少女' },
    { tag: 'ねこ', gist: 'ﾈｺ耳の少女' },
    { tag: 'ヴァイオリン', gist: 'ゔぁいおりんを弾く少女' },
  ])('matches the tag $tag in "$gist" regardless of hiragana and katakana', ({ tag, gist }) => {
    const items = [item({ id: 'cat', tags: [tag] })];

    const { selected } = selectMemory(items, gist, roomy);

    expect(ids(selected)).toEqual(['cat']);
  });

  it.each([
    { tag: 'ビール', gist: '高いビルの夜景' },
    { tag: 'ビル', gist: 'ビールを飲む少女' },
    { tag: 'はけ', gist: 'バケツを持つ少女' },
    { tag: 'ハン', gist: 'パンを食べる少女' },
    { tag: 'ビヨウイン', gist: 'びょういんの待合室' },
  ])(
    'does not match the tag $tag in "$gist", which differs by a long vowel, voicing or small kana',
    ({ tag, gist }) => {
      const items = [item({ id: 'other', tags: [tag] })];

      const { selected } = selectMemory(items, gist, roomy);

      expect(selected).toEqual([]);
    },
  );

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

  // かなの違いを越えて当てるために、同じ語を両方の表記でタグに書いた項目がある。同じ語は2つと数えない
  it.each([
    { spellings: ['ねこ', 'ネコ'] },
    { spellings: ['ネコ', 'ﾈｺ'] },
    { spellings: ['Cat', 'cat'] },
  ])(
    'counts the tags $spellings, which are one word in different forms, as one matched tag',
    ({ spellings }) => {
      const items = [
        item({ id: 'one-word', tags: spellings, updatedAt: '2026-10-02T00:00:00Z' }),
        item({ id: 'two-words', tags: [spellings[0]!, '海'] }),
        item({ id: 'one-word-newer', tags: [spellings[0]!], updatedAt: '2026-10-09T00:00:00Z' }),
      ];

      const { selected } = selectMemory(items, `${spellings[1]}と海`, roomy);

      expect(ids(selected)).toEqual(['two-words', 'one-word-newer', 'one-word']);
    },
  );

  it('keeps the passed amount within the budget even with hundreds of items', () => {
    const items = Array.from({ length: 500 }, (_, n) =>
      item({
        id: `m${String(n).padStart(3, '0')}`,
        body: `好みの項目 ${n} `.repeat(3),
        scope: 'always',
      }),
    );
    const budget = { maxCount: 20, maxSize: 400 };

    const { selected } = selectMemory(items, '少女', budget);

    expect(selected.length).toBeLessThanOrEqual(budget.maxCount);
    expect(selected.reduce((sum, i) => sum + i.body.length, 0)).toBeLessThanOrEqual(budget.maxSize);
  });

  it('reports every relevant item it left out because of the budget', () => {
    const items = Array.from({ length: 300 }, (_, n) =>
      item({ id: `m${String(n).padStart(3, '0')}`, scope: 'always' }),
    );

    const { selected, droppedByBudget } = selectMemory(items, '少女', {
      maxCount: 10,
      maxSize: 10_000,
    });

    expect(selected).toHaveLength(10);
    expect(droppedByBudget).toHaveLength(290);
    expect(droppedByBudget.every((d) => d.reason === 'count')).toBe(true);
    expect(new Set([...ids(selected), ...droppedByBudget.map((d) => d.item.id)]).size).toBe(300);
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

    const { selected, droppedByBudget } = selectMemory(items, '', { maxCount: 10, maxSize: 10 });

    expect(ids(selected)).toEqual(['short']);
    expect(droppedByBudget).toEqual([{ item: items[0], reason: 'size' }]);
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

describe('selectMemory with a separate frame for always items', () => {
  const manyAlways = (count: number) =>
    Array.from({ length: count }, (_, n) =>
      item({
        id: `always-${String(n).padStart(3, '0')}`,
        scope: 'always',
        updatedAt: '2026-10-09T00:00:00Z',
      }),
    );

  it('keeps passing tagged items that match the request however many always items there are', () => {
    const items = [...manyAlways(300), item({ id: 'anime', tags: ['アニメ'] })];

    const { selected } = selectMemory(items, 'アニメ調の少女', {
      maxCount: 3,
      maxSize: 10_000,
      always: { maxCount: 3, maxSize: 10_000 },
    });

    expect(ids(selected)).toContain('anime');
    expect(selected.filter((i) => i.scope === 'always')).toHaveLength(3);
  });

  it('keeps each frame within its own budget and reports what each frame left out', () => {
    const tagged = Array.from({ length: 200 }, (_, n) =>
      item({ id: `anime-${String(n).padStart(3, '0')}`, tags: ['アニメ'] }),
    );
    const limits = {
      maxCount: 4,
      maxSize: 10_000,
      always: { maxCount: 2, maxSize: 10_000 },
    };

    const { selected, droppedByBudget } = selectMemory(
      [...manyAlways(100), ...tagged],
      'アニメ',
      limits,
    );

    expect(selected.filter((i) => i.scope === 'always')).toHaveLength(2);
    expect(selected.filter((i) => i.scope === 'tagged')).toHaveLength(4);
    expect(droppedByBudget).toHaveLength(98 + 196);
  });

  it('does not let tagged items use room that the always frame left unused', () => {
    const items = [
      item({ id: 'always', scope: 'always' }),
      item({ id: 'anime-1', tags: ['アニメ'] }),
      item({ id: 'anime-2', tags: ['アニメ'] }),
    ];

    const { selected } = selectMemory(items, 'アニメ', {
      maxCount: 1,
      always: { maxCount: 5 },
    });

    expect(selected).toHaveLength(2);
  });
});

describe('selectMemory accounting', () => {
  it('counts every relevant item as either selected or dropped, however many there are', () => {
    const items = Array.from({ length: 120 }, (_, n) =>
      item({ id: `m${String(n).padStart(3, '0')}`, scope: 'always' }),
    );

    const { selected, droppedByBudget } = selectMemory(items, '少女', {
      maxCount: 200,
      maxSize: 10_000,
    });

    expect(selected).toHaveLength(120);
    expect(selected.length + droppedByBudget.length).toBe(120);
  });

  it('does not describe a dropped tagged item as dropped from the always frame', () => {
    const items = [
      item({ id: 'always', scope: 'always' }),
      item({ id: 'anime-1', tags: ['アニメ'], updatedAt: '2026-10-09T00:00:00Z' }),
      item({ id: 'anime-2', tags: ['アニメ'] }),
    ];
    const limits = { maxCount: 1, maxSize: 10_000, always: { maxCount: 1, maxSize: 10_000 } };

    const { droppedByBudget } = selectMemory(items, 'アニメ', limits);

    expect(droppedByBudget.map((d) => d.item.id)).toEqual(['anime-2']);
    expect(describeMemoryDrop(droppedByBudget[0]!, limits)).not.toContain('always 枠');
  });

  it('drops always items that exceed the always frame size limit and reports them as size drops', () => {
    const items = [
      item({ id: 'a', body: 'あ'.repeat(6), scope: 'always', updatedAt: '2026-10-09T00:00:00Z' }),
      item({ id: 'b', body: 'い'.repeat(6), scope: 'always', updatedAt: '2026-10-08T00:00:00Z' }),
      item({ id: 'c', body: 'う'.repeat(6), scope: 'always', updatedAt: '2026-10-07T00:00:00Z' }),
    ];
    const limits = { maxCount: 10, maxSize: 10_000, always: { maxCount: 10, maxSize: 10 } };

    const { selected, droppedByBudget } = selectMemory(items, '少女', limits);

    expect(ids(selected)).toEqual(['a']);
    expect(droppedByBudget.map((d) => [d.item.id, d.reason])).toEqual([
      ['b', 'size'],
      ['c', 'size'],
    ]);
  });
});

describe('DEFAULT_MEMORY_LIMITS', () => {
  // 既定値そのものと比べると、既定値を変えても試験が一緒に通ってしまうので、数を直に書く
  const always = Array.from({ length: 250 }, (_, n) =>
    item({ id: `always-${String(n).padStart(3, '0')}`, body: 'あ'.repeat(50), scope: 'always' }),
  );
  const tagged = Array.from({ length: 250 }, (_, n) =>
    item({
      id: `anime-${String(n).padStart(3, '0')}`,
      body: 'い'.repeat(50),
      tags: ['アニメ'],
    }),
  );
  const chars = (items: readonly MemoryItem[]) => items.reduce((sum, i) => sum + i.body.length, 0);

  it.each([
    { role: 'think' as const, count: 8, size: 400, alwaysCount: 5, alwaysSize: 200 },
    { role: 'judge' as const, count: 5, size: 240, alwaysCount: 4, alwaysSize: 160 },
  ])(
    'keeps what the $role role receives within its count and character limits',
    ({ role, count, size, alwaysCount, alwaysSize }) => {
      const { selected } = selectMemory(
        [...always, ...tagged],
        'アニメ調の少女',
        DEFAULT_MEMORY_LIMITS[role],
      );

      const selectedAlways = selected.filter((i) => i.scope === 'always');
      const selectedTagged = selected.filter((i) => i.scope === 'tagged');
      expect(selectedAlways.length).toBeLessThanOrEqual(alwaysCount);
      expect(chars(selectedAlways)).toBeLessThanOrEqual(alwaysSize);
      expect(selectedTagged.length).toBeGreaterThan(0);
      expect(selectedTagged.length).toBeLessThanOrEqual(count);
      expect(chars(selectedTagged)).toBeLessThanOrEqual(size);
    },
  );
});
