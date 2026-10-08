import { describe, expect, it } from 'vitest';

import type { Candidate } from '../backend.js';
import { selectCandidates } from './select.js';

const roomy = { maxItems: 100, maxChars: 10_000 };
const noNotes = new Map<string, string>();
const loras = (count: number): Candidate[] =>
  Array.from({ length: count }, (_, n) => ({ name: `lora_${String(n).padStart(3, '0')}` }));
const names = (shown: readonly { name: string }[]) => shown.map((c) => c.name);

describe('selectCandidates', () => {
  it('keeps the list within the budget even with hundreds of LoRAs', () => {
    const budget = { maxItems: 30, maxChars: 200 };

    const { shown } = selectCandidates(loras(600), undefined, noNotes, '', budget);

    expect(shown.length).toBeLessThanOrEqual(budget.maxItems);
    const chars = shown.reduce((sum, c) => sum + c.name.length + (c.note?.length ?? 0), 0);
    expect(chars).toBeLessThanOrEqual(budget.maxChars);
  });

  it('reports every allowed candidate it left out because of the budget', () => {
    const { shown, droppedByBudget } = selectCandidates(loras(300), undefined, noNotes, '', {
      maxItems: 10,
      maxChars: 10_000,
    });

    expect(shown).toHaveLength(10);
    expect(droppedByBudget).toHaveLength(290);
  });

  it('offers only the candidates the human narrowed the choice to', () => {
    const { shown, droppedByBudget } = selectCandidates(
      loras(5),
      ['lora_001', 'lora_003'],
      noNotes,
      '',
      roomy,
    );

    expect(names(shown)).toEqual(['lora_001', 'lora_003']);
    expect(droppedByBudget).toEqual([]);
  });

  it('puts candidates with a human note first, then those named in the request, then the rest', () => {
    const candidates: Candidate[] = [
      { name: 'aaa_plain' },
      { name: 'bbb_mentioned' },
      { name: 'ccc_labeled', label: 'Watercolor Style' },
      { name: 'zzz_noted' },
    ];
    const notes = new Map([['zzz_noted', '水彩の質感を足す']]);

    const { shown } = selectCandidates(
      candidates,
      undefined,
      notes,
      'bbb_mentioned で watercolor style に',
      roomy,
    );

    expect(names(shown)).toEqual(['zzz_noted', 'bbb_mentioned', 'ccc_labeled', 'aaa_plain']);
  });

  it('passes the human note along with the candidate', () => {
    const notes = new Map([['lora_000', '水彩の質感を足す']]);

    const { shown } = selectCandidates(loras(1), undefined, notes, '', roomy);

    expect(shown).toEqual([{ name: 'lora_000', note: '水彩の質感を足す' }]);
  });

  it('drops a note that does not fit but still shows the candidate by name', () => {
    const notes = new Map([['lora_000', 'あ'.repeat(100)]]);

    const { shown, droppedByBudget, notesDroppedByBudget } = selectCandidates(
      loras(2),
      undefined,
      notes,
      '',
      {
        maxItems: 10,
        maxChars: 50,
      },
    );

    expect(shown).toEqual([{ name: 'lora_000' }, { name: 'lora_001' }]);
    expect(droppedByBudget).toEqual([]);
    expect(notesDroppedByBudget).toEqual(['lora_000']);
  });

  it('drops notes before dropping any candidate whose name would still fit', () => {
    const notes = new Map([['lora_000', 'あ'.repeat(10)]]);

    const { shown, notesDroppedByBudget } = selectCandidates(loras(2), undefined, notes, '', {
      maxItems: 10,
      maxChars: 20,
    });

    expect(names(shown)).toEqual(['lora_000', 'lora_001']);
    expect(notesDroppedByBudget).toEqual(['lora_000']);
  });

  it('drops the candidate itself only when even its name does not fit', () => {
    const { shown, droppedByBudget } = selectCandidates(loras(3), undefined, noNotes, '', {
      maxItems: 10,
      maxChars: 16,
    });

    expect(names(shown)).toEqual(['lora_000', 'lora_001']);
    expect(droppedByBudget).toEqual(['lora_002']);
  });
});
