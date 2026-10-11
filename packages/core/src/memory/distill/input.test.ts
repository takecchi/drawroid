// 蒸留の入力の本文（LLM に渡る文字列）の組み方を見る試験: 既存の項目の書き方と、口出しと会話の発言の重なり
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_WINDOW } from '../../loop/budget.js';
import type { MemoryItem } from '../item.js';
import { DEFAULT_DISTILL_BUDGET } from './budget.js';
import {
  buildReselectionDistillInput,
  buildStoppedJobDistillInput,
  type DistillInput,
  type StoppedJobMaterial,
} from './input.js';

const budget = DEFAULT_DISTILL_BUDGET;
const window = DEFAULT_MODEL_WINDOW;

const textOf = (input: DistillInput) =>
  input.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

const memoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: '8d9c7f51',
  body: '白いワンピースの少女',
  tags: ['アニメ調', '夕暮れの海辺', '少女'],
  scope: 'always',
  sources: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...overrides,
});

const material = (overrides: Partial<StoppedJobMaterial> = {}): StoppedJobMaterial => ({
  jobId: '20261009-063012-job1',
  intent: '夕暮れの海辺に立つ白いワンピースの少女を描いて',
  stopReason: { kind: 'limit:duration', detail: '300 秒に達した' },
  interventions: [],
  selections: [],
  ...overrides,
});

const stopped = (m: StoppedJobMaterial, memory: MemoryItem[] = []) =>
  buildStoppedJobDistillInput({ material: m, memory, budget, window });

describe('an existing memory item in the distill input', () => {
  it('names the scope and the tags apart so that the scope is not read as a tag', () => {
    const text = textOf(stopped(material(), [memoryItem()]));

    expect(text).toContain(
      '既存の項目 8d9c7f51（範囲: always、タグ: アニメ調, 夕暮れの海辺, 少女）: 白いワンピースの少女',
    );
  });

  it('names only the scope when the item has no tags', () => {
    const text = textOf(stopped(material(), [memoryItem({ tags: [], scope: 'always' })]));

    expect(text).toContain('既存の項目 8d9c7f51（範囲: always）: 白いワンピースの少女');
  });

  it('is written the same way in the input after the selection changed', () => {
    const input = buildReselectionDistillInput({
      material: { jobId: 'job-x', intent: '夕暮れの海辺の少女', changes: [] },
      memory: [memoryItem({ scope: 'tagged', tags: ['少女'] })],
      budget,
      window,
    });

    expect(textOf(input)).toContain(
      '既存の項目 8d9c7f51（範囲: tagged、タグ: 少女）: 白いワンピースの少女',
    );
  });
});

describe('the human words that are both an intervention and a conversation message', () => {
  const said = 'もっと逆光にして。夕日が少女の後ろにくるように。';
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('appear once, as the intervention', () => {
    const text = textOf(
      stopped(
        material({
          interventions: [{ id: 'i1', text: said }],
          conversation: [
            { id: '3', text: 'まだ描き始まっていないみたい。' },
            { id: '9', text: said },
          ],
        }),
      ),
    );

    expect(count(text, said)).toBe(1);
    expect(text).toContain(`口出し: ${said}`);
    expect(text).toContain('会話での人間の発言: まだ描き始まっていないみたい。');
  });

  it('are matched after normalizing width, case and kana, ignoring surrounding spaces', () => {
    const input = stopped(
      material({
        interventions: [{ id: 'i1', text: 'Backlight を強く、ﾊﾞｯｸﾗｲﾄ' }],
        conversation: [{ id: '9', text: '  ＢＡＣＫＬＩＧＨＴ を強く、バックライト \n' }],
      }),
    );

    expect(textOf(input)).not.toContain('会話での人間の発言');
  });

  it('are kept in the conversation when the wording only differs', () => {
    const text = textOf(
      stopped(
        material({
          interventions: [{ id: 'i1', text: 'もっと逆光にして' }],
          conversation: [
            { id: '8', text: 'もっと逆光にして。夕日が少女の後ろにくるように。' },
            { id: '9', text: '逆光にして' },
          ],
        }),
      ),
    );

    expect(text).toContain('会話での人間の発言: もっと逆光にして。夕日が少女の後ろにくるように。');
    expect(text).toContain('会話での人間の発言: 逆光にして');
  });

  it('are left in the notes as dropped for being the same as the intervention', () => {
    const input = stopped(
      material({
        interventions: [{ id: 'i1', text: said }],
        conversation: [{ id: '9', text: said }],
      }),
    );

    expect(input.messages.report.notes).toContainEqual(
      expect.objectContaining({
        kind: 'dropped',
        section: 'message[9]',
        reason: '同じ文が口出しにある',
      }),
    );
  });

  it('stay in the conversation when the intervention itself did not fit the budget', () => {
    const interventions = Array.from(
      { length: (budget.interventions.maxCount ?? 0) + 1 },
      (_, n) => ({ id: `i${n}`, text: n === 0 ? said : `別の口出し ${n}` }),
    );
    const text = textOf(
      stopped(material({ interventions, conversation: [{ id: '9', text: said }] })),
    );

    expect(text).toContain(`会話での人間の発言: ${said}`);
  });

  it('do not use up the message budget of the other words', () => {
    const others = Array.from({ length: budget.messages.maxCount ?? 0 }, (_, n) => ({
      id: `o${n}`,
      text: `別の発言 ${n}`,
    }));
    const text = textOf(
      stopped(
        material({
          interventions: [{ id: 'i1', text: said }],
          conversation: [...others, { id: '9', text: said }],
        }),
      ),
    );

    for (const other of others) expect(text).toContain(other.text);
  });
});
