import { describe, expect, it } from 'vitest';
import type { BudgetedMessages } from '../llm/port.js';
import { DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW, type Budget } from './budget.js';
import { advanceCarry, createCarry, type Carry } from './carry.js';
import {
  buildJudgeInput,
  buildThinkInput,
  ImageNotAllowedError,
  InputOverBudgetError,
  progressOf,
  type PreviewImage,
  type Progress,
} from './inputs.js';
import { THINK_PARAM_KEYS, type JudgeOutput, type ThinkParams } from './schemas.js';

const budget = DEFAULT_BUDGET;
const window = DEFAULT_MODEL_WINDOW;

/** 各欄を上限いっぱいの日本語で埋める（見積もりがいちばん大きくなる形） */
const full = (limit: number) => 'あ'.repeat(limit);

function worstThink(b: Budget): ThinkParams {
  return {
    prompt: full(b.text.prompt),
    negativePrompt: full(b.text.negativePrompt),
    seed: 4294967295,
    steps: 150,
    cfgScale: 30,
  };
}

function worstJudge(b: Budget, images: number, score: (i: number) => number): JudgeOutput {
  return {
    images: Array.from({ length: images }, (_, i) => ({
      score: score(i),
      issues: Array.from({ length: b.issuesPerImage }, () => full(b.text.issue)),
    })),
    nextChange: full(b.text.nextChange),
    canStop: false,
  };
}

function textLength(messages: BudgetedMessages): number {
  return messages.user.reduce((sum, p) => sum + (p.type === 'text' ? [...p.text].length : 0), 0);
}

function preview(key: string, longEdge = budget.imageLongEdge): PreviewImage {
  return { key, data: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', longEdge };
}

/** 回を n 回重ねた状態。1回目が最良のままなので、2回目以降は最良と直近が別の回になる */
function carryAfter(n: number): Carry {
  let carry = createCarry(full(budget.text.intent), budget).carry;
  for (let i = 1; i <= n; i += 1) {
    const judge = worstJudge(budget, budget.imagesPerJudge, () => (i === 1 ? 0.9 : 0.1));
    carry = advanceCarry(carry, i, worstThink(budget), judge);
  }
  return carry;
}

describe('buildThinkInput', () => {
  it('keeps the input within the same limit at iteration 1 and iteration 30', () => {
    const sizes = [0, 1, 2, 10, 29, 299].map((done) => {
      const messages = buildThinkInput({
        carry: carryAfter(done),
        progress: { iteration: done + 1, remainingIterations: 300 - done },
        allowed: THINK_PARAM_KEYS,
        budget,
        window,
      });
      expect(messages.report.estimatedInputTokens).toBeLessThanOrEqual(
        messages.report.inputTokenLimit,
      );
      return textLength(messages);
    });
    // 3回目以降は最良と直近の2区画で頭打ちになる。回数に比例して増えるのは、回の番号の桁だけ
    const third = sizes[2] ?? 0;
    for (const size of sizes) expect(size).toBeLessThanOrEqual(third + 8);
  });

  it('does not repeat the latest result when it is also the best', () => {
    let carry = createCarry('海辺の少女', budget).carry;
    carry = advanceCarry(
      carry,
      1,
      { prompt: 'girl, beach' },
      worstJudge(budget, 1, () => 0.9),
    );
    const text = buildThinkInput({
      carry,
      progress: { iteration: 2 },
      allowed: THINK_PARAM_KEYS,
      budget,
      window,
    }).user[0];
    expect(text).toMatchObject({ type: 'text' });
    expect(text?.type === 'text' && text.text.includes('最良')).toBe(true);
    expect(text?.type === 'text' && text.text.includes('直近')).toBe(false);
  });

  it('writes the source image keys only when img2img is left to the AI', () => {
    const text = (withImageSourceKeys: boolean) =>
      buildThinkInput({
        carry: carryAfter(2),
        progress: { iteration: 3 },
        allowed: THINK_PARAM_KEYS,
        budget,
        window,
        withImageSourceKeys,
      })
        .user.map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
    expect(text(true)).toContain('最良（元画像のキー best）');
    expect(text(true)).toContain('直近（元画像のキー latest）');
    expect(text(false)).toContain('最良');
    expect(text(false)).not.toContain('元画像のキー');
  });

  it('drops optional sections that do not fit and records them', () => {
    const tight = { contextTokens: 2400, maxOutputTokens: 400 };
    const messages = buildThinkInput({
      carry: carryAfter(3),
      progress: { iteration: 4 },
      allowed: THINK_PARAM_KEYS,
      budget,
      window: tight,
    });
    expect(messages.report.estimatedInputTokens).toBeLessThanOrEqual(
      messages.report.inputTokenLimit,
    );
    expect(messages.report.notes).toContainEqual({
      kind: 'dropped',
      section: 'latest',
      reason: '入力の上限に入らない',
    });
  });

  it('refuses when the required sections alone exceed the window', () => {
    expect(() =>
      buildThinkInput({
        carry: carryAfter(0),
        progress: { iteration: 1 },
        allowed: THINK_PARAM_KEYS,
        budget,
        window: { contextTokens: 500, maxOutputTokens: 400 },
      }),
    ).toThrow(InputOverBudgetError);
  });

  it('accepts required sections that fill the window exactly, and refuses one token more', () => {
    // 任意の節の無い入力（最良も参照画像も記憶も無い）: 見積もりが、そのまま必須の部分の大きさになる
    const judgeInput = (contextTokens: number) =>
      buildJudgeInput({
        carry: createCarry('海辺', budget).carry,
        images: [preview('img-0')],
        budget,
        window: { contextTokens, maxOutputTokens: 100 },
      });
    const required = judgeInput(1_000_000).report.estimatedInputTokens;

    // 上限ちょうどは「超えていない」ので通す
    expect(judgeInput(required + 100).report.estimatedInputTokens).toBe(required);
    expect(() => judgeInput(required + 99)).toThrow(InputOverBudgetError);
  });

  it('clips a carried text that exceeds the current budget and records it', () => {
    const carry: Carry = { intent: full(budget.text.intent + 50), completedIterations: 0 };
    const messages = buildThinkInput({
      carry,
      progress: { iteration: 1 },
      allowed: THINK_PARAM_KEYS,
      budget,
      window,
    });
    expect(messages.report.notes).toContainEqual({
      kind: 'clipped',
      section: 'intent',
      from: budget.text.intent + 50,
      to: budget.text.intent,
    });
  });
});

describe('buildJudgeInput', () => {
  it('keeps the input within the same limit at iteration 1 and iteration 30', () => {
    const images = Array.from({ length: budget.imagesPerJudge }, (_, i) => preview(`img-${i}`));
    const sizes = [0, 1, 29, 299].map((done) => {
      const messages = buildJudgeInput({ carry: carryAfter(done), images, budget, window });
      expect(messages.report.estimatedInputTokens).toBeLessThanOrEqual(
        messages.report.inputTokenLimit,
      );
      return textLength(messages);
    });
    const second = sizes[1] ?? 0;
    for (const size of sizes) expect(size).toBeLessThanOrEqual(second + 8);
  });

  it('passes only the given previews as images, never the best image of earlier iterations', () => {
    const messages = buildJudgeInput({
      carry: carryAfter(5),
      images: [preview('job/0006/0')],
      budget,
      window,
    });
    const keys = messages.user.flatMap((p) => (p.type === 'image' ? [p.key] : []));
    expect(keys).toEqual(['job/0006/0']);
  });

  it('refuses an image that was already sent', () => {
    expect(() =>
      buildJudgeInput({
        carry: carryAfter(1),
        images: [{ ...preview('job/0001/0'), sentInCall: 'call-1' }],
        budget,
        window,
      }),
    ).toThrow(ImageNotAllowedError);
  });

  it('refuses an image larger than the preview long edge', () => {
    expect(() =>
      buildJudgeInput({
        carry: carryAfter(1),
        images: [preview('job/0001/0', 1024)],
        budget,
        window,
      }),
    ).toThrow(ImageNotAllowedError);
  });

  it('refuses more images than one call may carry', () => {
    const images = Array.from({ length: budget.imagesPerJudge + 1 }, (_, i) => preview(`img-${i}`));
    expect(() => buildJudgeInput({ carry: carryAfter(1), images, budget, window })).toThrow(
      ImageNotAllowedError,
    );
  });
});

describe('the default budget', () => {
  it('fits the worst case of both roles into the default model window', () => {
    const carry = carryAfter(2);
    const think = buildThinkInput({
      carry,
      progress: { iteration: 3, remainingIterations: 99 },
      allowed: THINK_PARAM_KEYS,
      budget,
      window,
    });
    const judge = buildJudgeInput({
      carry,
      images: Array.from({ length: budget.imagesPerJudge }, (_, i) => preview(`img-${i}`)),
      budget,
      window,
    });
    expect(think.report.notes.filter((n) => n.kind === 'dropped')).toEqual([]);
    expect(judge.report.notes.filter((n) => n.kind === 'dropped')).toEqual([]);
  });
});

describe('issues carried into the next call', () => {
  it('lists only issuesPerImage issues of the best result and notes that it clipped the rest', () => {
    const extra = budget.issuesPerImage + 2;
    const issues = Array.from({ length: extra }, (_, i) => `issue-${i}`);
    const best = {
      iteration: 1,
      imageIndex: 0,
      score: 0.5,
      params: {},
      issues,
      nextChange: 'change',
    };
    const carry: Carry = { intent: 'request', completedIterations: 1, best, latest: best };
    const messages = buildThinkInput({
      carry,
      progress: { iteration: 2 },
      allowed: THINK_PARAM_KEYS,
      budget,
      window,
    });
    const text = messages.user.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toContain(`issue-${budget.issuesPerImage - 1}`);
    expect(text).not.toContain(`issue-${budget.issuesPerImage}`);
    expect(messages.report.notes).toContainEqual({
      kind: 'clipped',
      section: 'best.issues',
      from: extra,
      to: budget.issuesPerImage,
    });
  });
});

describe('progressOf', () => {
  it('carries only the remaining counts whose limit the stop conditions have', () => {
    const at = { iteration: 3, imagesGenerated: 4, elapsedMs: 90_000 };
    expect(progressOf({ ...at, conditions: { aiJudgement: true } })).toEqual({ iteration: 3 });
    expect(
      progressOf({
        ...at,
        conditions: { aiJudgement: true, maxIterations: 5, maxImages: 10, maxDurationMs: 600_000 },
      }),
    ).toEqual({ iteration: 3, remainingIterations: 3, remainingImages: 6, remainingMs: 510_000 });
  });

  it('does not count below zero when the limit has already passed', () => {
    expect(
      progressOf({
        iteration: 2,
        imagesGenerated: 12,
        elapsedMs: 700_000,
        conditions: { aiJudgement: true, maxImages: 10, maxDurationMs: 600_000 },
      }),
    ).toEqual({ iteration: 2, remainingImages: 0, remainingMs: 0 });
  });
});

describe('the progress line in the think input', () => {
  const lineFor = (progress: Progress) =>
    buildThinkInput({ carry: carryAfter(0), progress, allowed: ['prompt'], budget, window })
      .user.map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .split('\n')
      .find((line) => line.startsWith('これから'));

  it.each<[string, Progress, string]>([
    ['no limit', { iteration: 1 }, 'これから 1 回目。'],
    [
      'every limit',
      { iteration: 2, remainingIterations: 4, remainingImages: 7, remainingMs: 330_000 },
      'これから 2 回目（残り 4 回・7 枚・約 5 分）。',
    ],
    [
      'only the time, under a minute',
      { iteration: 5, remainingMs: 59_999 },
      'これから 5 回目（残り 1 分未満）。',
    ],
    [
      'only the images, none left',
      { iteration: 3, remainingImages: 0 },
      'これから 3 回目（残り 0 枚）。',
    ],
  ])('reads %s', (_name, progress, head) => {
    expect(lineFor(progress)).toBe(`${head}決めてよいパラメータ: prompt`);
  });
});
