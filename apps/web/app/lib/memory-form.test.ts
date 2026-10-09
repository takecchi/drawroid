import { describe, expect, it } from 'vitest';

import {
  bodyHead,
  buildSaveInput,
  memoryToFormValues,
  parseTags,
  type MemoryItem,
} from './memory-form';

const item: MemoryItem = {
  id: 'm1',
  body: '指の崩れは許容しない',
  tags: ['hands', 'anatomy'],
  scope: 'always',
  sources: ['j1'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

describe('parseTags', () => {
  it('splits on commas, trims, drops empties and duplicates', () => {
    expect(parseTags(' a, b ,,a, c, ')).toEqual(['a', 'b', 'c']);
  });

  it('accepts full-width separators', () => {
    expect(parseTags('猫、犬，鳥')).toEqual(['猫', '犬', '鳥']);
  });

  it('returns no tags for blank text', () => {
    expect(parseTags('  ')).toEqual([]);
  });
});

describe('memoryToFormValues', () => {
  it('joins the tags with commas', () => {
    expect(memoryToFormValues(item)).toEqual({
      body: '指の崩れは許容しない',
      tags: 'hands, anatomy',
      scope: 'always',
    });
  });
});

describe('buildSaveInput', () => {
  it('builds the body of the save request with the updatedAt the screen opened', () => {
    expect(
      buildSaveInput(
        { body: '  手の崩れは許容しない\n', tags: 'hands, , anatomy', scope: 'tagged' },
        item.updatedAt,
      ),
    ).toEqual({
      body: '手の崩れは許容しない',
      tags: ['hands', 'anatomy'],
      scope: 'tagged',
      expectedUpdatedAt: item.updatedAt,
    });
  });
});

describe('bodyHead', () => {
  it('keeps a short body as it is', () => {
    expect(bodyHead('短い')).toBe('短い');
  });

  it('cuts a long body and joins lines', () => {
    expect(bodyHead('あいう\nえお', 4)).toBe('あいう …');
    expect(bodyHead('あいうえお', 3)).toBe('あいう…');
  });
});
