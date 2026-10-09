import { describe, expect, it } from 'vitest';
import { packWithinBudget } from './pack.js';

type Item = { id: string; size: number; priority: number };
const item = (id: string, size: number, priority = 0): Item => ({ id, size, priority });
const ids = (items: readonly Item[]) => items.map((i) => i.id);

describe('packWithinBudget', () => {
  it('includes everything when nothing exceeds the limits', () => {
    const result = packWithinBudget([item('a', 2), item('b', 3)], {
      size: (i) => i.size,
      limits: { maxCount: 5, maxSize: 10 },
    });
    expect(ids(result.included)).toEqual(['a', 'b']);
    expect(result.dropped).toEqual([]);
    expect(result.usedSize).toBe(5);
  });

  it('fills in priority order and keeps the input order among equal priorities', () => {
    const result = packWithinBudget([item('low', 1, 2), item('high1', 1, 1), item('high2', 1, 1)], {
      size: (i) => i.size,
      compare: (a, b) => a.priority - b.priority,
      limits: { maxCount: 2 },
    });
    expect(ids(result.included)).toEqual(['high1', 'high2']);
    expect(result.dropped.map((d) => [d.item.id, d.reason])).toEqual([['low', 'count']]);
  });

  it('drops an item that does not fit and still packs smaller ones after it', () => {
    const result = packWithinBudget([item('a', 4), item('big', 8), item('c', 3)], {
      size: (i) => i.size,
      limits: { maxSize: 10 },
    });
    expect(ids(result.included)).toEqual(['a', 'c']);
    expect(result.dropped.map((d) => [d.item.id, d.reason])).toEqual([['big', 'size']]);
    expect(result.usedSize).toBe(7);
  });

  it('never exceeds the limits however many items are given', () => {
    const many = Array.from({ length: 500 }, (_, i) => item(`lora-${i}`, (i % 7) + 1, i % 3));
    const result = packWithinBudget(many, {
      size: (i) => i.size,
      compare: (a, b) => a.priority - b.priority,
      limits: { maxCount: 40, maxSize: 100 },
    });
    expect(result.included.length).toBeLessThanOrEqual(40);
    expect(result.usedSize).toBeLessThanOrEqual(100);
    expect(result.included.length + result.dropped.length).toBe(500);
  });
});
