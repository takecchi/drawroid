// 止まったジョブの蒸留の材料に、そのジョブを作った会話の人間の発言を足し、会話の長さによらず予算内に収めることを見る試験（会話 K、#118）
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_WINDOW } from '../../loop/budget.js';
import { DEFAULT_DISTILL_BUDGET } from './budget.js';
import { buildStoppedJobDistillInput, type StoppedJobMaterial } from './input.js';

const budget = DEFAULT_DISTILL_BUDGET;

const material = (overrides: Partial<StoppedJobMaterial> = {}): StoppedJobMaterial => ({
  jobId: '20261009-063012-job1',
  intent: '夕暮れの海辺に立つ少女',
  stopReason: { kind: 'human', detail: '人間が止めた' },
  interventions: [],
  selections: [],
  ...overrides,
});

const textOf = (input: ReturnType<typeof buildStoppedJobDistillInput>) =>
  input.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

describe('the words a human said in the conversation that made the job', () => {
  it('puts them in the distill input as what the human said', () => {
    const input = buildStoppedJobDistillInput({
      material: material({
        conversation: [
          { id: '3', text: '指が崩れているのは嫌' },
          { id: '9', text: 'もっと逆光で' },
        ],
      }),
      memory: [],
      budget,
      window: DEFAULT_MODEL_WINDOW,
    });

    const text = textOf(input);
    expect(text).toContain('会話での人間の発言: 指が崩れているのは嫌');
    expect(text).toContain('会話での人間の発言: もっと逆光で');
  });

  it('keeps the input within budget however long the conversation is, preferring the latest words', () => {
    const long = Array.from({ length: 1000 }, (_, n) => ({
      id: String(n + 1),
      text: `${n + 1} 番目の発言`.padEnd(budget.messageChars + 50, 'あ'),
    }));
    const short = buildStoppedJobDistillInput({
      material: material({ conversation: long.slice(0, 1) }),
      memory: [],
      budget,
      window: DEFAULT_MODEL_WINDOW,
    });
    const lengths = [10, 100, 1000].map(
      (n) =>
        buildStoppedJobDistillInput({
          material: material({ conversation: long.slice(0, n) }),
          memory: [],
          budget,
          window: DEFAULT_MODEL_WINDOW,
        }).messages.report.estimatedInputTokens,
    );

    // 件数と文字数の予算で締めるので、会話が10倍に長くなっても入力は増えない（差は番号の桁の数だけ）
    expect(Math.abs(lengths[2]! - lengths[1]!)).toBeLessThan(20);
    expect(lengths[0]).toBeGreaterThan(short.messages.report.estimatedInputTokens);
    const all = buildStoppedJobDistillInput({
      material: material({ conversation: long }),
      memory: [],
      budget,
      window: DEFAULT_MODEL_WINDOW,
    });
    expect(textOf(all)).toContain('1000 番目の発言');
    expect(textOf(all)).not.toContain('1 番目の発言あ');
    expect(all.messages.report.notes).toContainEqual(
      expect.objectContaining({ kind: 'clipped', section: 'message[1000]' }),
    );
    expect(all.messages.report.notes).toContainEqual(
      expect.objectContaining({ kind: 'dropped', section: 'message[1]' }),
    );
  });

  it('adds nothing when the job was not made in a conversation', () => {
    const input = buildStoppedJobDistillInput({
      material: material(),
      memory: [],
      budget,
      window: DEFAULT_MODEL_WINDOW,
    });

    expect(textOf(input)).not.toContain('会話での人間の発言');
  });
});
