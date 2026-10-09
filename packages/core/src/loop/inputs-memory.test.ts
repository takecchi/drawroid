import { describe, expect, it } from 'vitest';

import type { BudgetedMessages } from '../llm/port.js';
import { toLlmCallRecord } from '../llm/record.js';
import type { MemoryItem } from '../memory/item.js';
import { DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from './budget.js';
import { advanceCarry, createCarry, type Carry } from './carry.js';
import { buildJudgeInput, buildThinkInput, type MemoryInput, type PreviewImage } from './inputs.js';
import { THINK_PARAM_KEYS } from './schemas.js';

const budget = DEFAULT_BUDGET;
const window = DEFAULT_MODEL_WINDOW;
const limits = { maxCount: 5, maxSize: 200 };

function memoryItem(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    body: `好みの項目 ${id}`,
    tags: [],
    scope: 'always',
    sources: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const manyItems = (count: number) =>
  Array.from({ length: count }, (_, n) => memoryItem(`m${String(n).padStart(4, '0')}`));

const carry: Carry = createCarry('夕暮れの海辺に立つ少女、アニメ調', budget).carry;

function think(memory: MemoryInput | undefined, from: Carry = carry, w = window) {
  return buildThinkInput({
    carry: from,
    progress: { iteration: 2 },
    allowed: THINK_PARAM_KEYS,
    budget,
    window: w,
    memory,
  });
}

const preview: PreviewImage = {
  key: 'img',
  data: new Uint8Array([1]),
  mediaType: 'image/webp',
  longEdge: 512,
};

function judge(memory: MemoryInput | undefined) {
  return buildJudgeInput({ carry, images: [preview], budget, window, memory });
}

const textOf = (messages: BudgetedMessages) =>
  messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('memory in the inputs of the think and judge roles', () => {
  it('gives the thinking role the preferences that relate to the request, and not the others', () => {
    const items = [
      memoryItem('fingers', { body: '指の崩れは許容しない' }),
      memoryItem('anime', {
        body: 'アニメ調はチェックポイント X が好き',
        scope: 'tagged',
        tags: ['アニメ'],
      }),
      memoryItem('photo', { body: '実写は彩度を控えめにする', scope: 'tagged', tags: ['実写'] }),
    ];

    const text = textOf(think({ items, limits }));

    expect(text).toContain('指の崩れは許容しない');
    expect(text).toContain('アニメ調はチェックポイント X が好き');
    expect(text).not.toContain('実写は彩度を控えめにする');
  });

  it('gives the judging role the preferences too, so they count in the evaluation', () => {
    const text = textOf(
      judge({ items: [memoryItem('fingers', { body: '指の崩れは許容しない' })], limits }),
    );

    expect(text).toContain('指の崩れは許容しない');
  });

  it('does not grow the input with the number of stored preferences', () => {
    const few = think({ items: manyItems(5), limits });
    const many = think({ items: manyItems(800), limits });

    expect(textOf(many).length).toBe(textOf(few).length);
    expect(many.report.estimatedInputTokens).toBeLessThanOrEqual(many.report.inputTokenLimit);
    const judged = judge({ items: manyItems(800), limits });
    expect(judged.report.estimatedInputTokens).toBe(
      judge({ items: manyItems(5), limits }).report.estimatedInputTokens,
    );
  });

  it('records each preference it left out because of the memory budget, by id and reason', () => {
    const messages = think({ items: manyItems(300), limits });

    const dropped = messages.report.notes.filter((note) => note.section.startsWith('memory['));
    expect(dropped).toHaveLength(295);
    expect(dropped[0]).toEqual({
      kind: 'dropped',
      section: 'memory[m0005]',
      reason: '記憶の件数の予算に入らない',
    });
  });

  it('carries the left-out preferences into the record of the LLM call', () => {
    const messages = judge({ items: manyItems(10), limits });

    const record = toLlmCallRecord({
      callId: 'c1',
      jobId: 'j1',
      iteration: 2,
      role: 'judge',
      purpose: 'judge',
      provider: 'stub',
      model: 'stub',
      startedAt: new Date('2026-10-09T00:00:00Z'),
      messages,
      outcome: { ok: true, value: {}, attempts: [] },
    });

    expect(record.budget.notes.filter((note) => note.section.startsWith('memory['))).toHaveLength(
      5,
    );
  });

  it('drops preferences before the best and latest results when the whole input does not fit', () => {
    let worn = carry;
    const issues = Array.from({ length: budget.issuesPerImage }, () =>
      'あ'.repeat(budget.text.issue),
    );
    const judged = (score: number) => ({
      images: [{ score, issues }],
      nextChange: 'あ'.repeat(budget.text.nextChange),
      canStop: false,
    });
    worn = advanceCarry(worn, 1, { prompt: 'あ'.repeat(budget.text.prompt) }, judged(0.9));
    worn = advanceCarry(worn, 2, { prompt: 'あ'.repeat(budget.text.prompt) }, judged(0.1));
    const items = manyItems(5).map((item) => ({ ...item, body: 'い'.repeat(40) }));
    const withoutMemory = think(undefined, worn);
    const tight = {
      contextTokens: withoutMemory.report.estimatedInputTokens + window.maxOutputTokens + 10,
      maxOutputTokens: window.maxOutputTokens,
    };

    const messages = think({ items, limits }, worn, tight);

    const droppedSections = messages.report.notes
      .filter((n) => n.kind === 'dropped')
      .map((n) => n.section);
    expect(droppedSections).not.toContain('best');
    expect(droppedSections).not.toContain('latest');
    expect(droppedSections.filter((s) => s.startsWith('memory['))).toHaveLength(5);
  });

  it('leaves the input as before when no memory is given', () => {
    expect(textOf(think(undefined))).not.toContain('好み');
  });
});
