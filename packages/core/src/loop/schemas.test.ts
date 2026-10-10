import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import type { Permissions } from '../permissions/permission.js';
import { buildParamsSchema } from '../think/params-schema.js';
import { DEFAULT_BUDGET } from './budget.js';
import {
  buildJudgeOutputSchema,
  buildJudgeRecordSchema,
  buildThinkOutputSchema,
  THINK_PARAM_KEYS,
} from './schemas.js';

const budget = DEFAULT_BUDGET;

/** 渡したパラメータだけを AI に任せ、残りは使わない許可から、パラメータの部分を組み立てる */
function paramsAllowing(keys: readonly ParamKey[]) {
  const permissions = Object.fromEntries(
    PARAM_KEYS.map((key) => [key, keys.includes(key) ? { mode: 'auto' } : { mode: 'off' }]),
  ) as Permissions;
  return buildParamsSchema(permissions, { shown: {}, budget });
}

function paramKeysOf(schema: ReturnType<typeof buildThinkOutputSchema>): string[] {
  const json = z.toJSONSchema(schema) as unknown as {
    properties: { params: { properties?: Record<string, unknown> } };
  };
  return Object.keys(json.properties.params.properties ?? {});
}

describe('buildThinkOutputSchema', () => {
  it('contains only the allowed parameters', () => {
    expect(paramKeysOf(buildThinkOutputSchema(paramsAllowing(['prompt', 'seed'])))).toEqual([
      'prompt',
      'seed',
    ]);
  });

  it('does not hand a disallowed parameter through even if the model returns it', () => {
    const parsed = buildThinkOutputSchema(paramsAllowing(['prompt'])).parse({
      params: { prompt: 'girl, beach', cfgScale: 20 },
      rationale: '逆光にする',
    });
    expect(parsed.params).toEqual({ prompt: 'girl, beach' });
  });

  it('accepts a prompt and a rationale longer than the input budget', () => {
    const result = buildThinkOutputSchema(paramsAllowing(['prompt'])).safeParse({
      params: { prompt: 'a'.repeat(budget.text.prompt + 1) },
      rationale: 'あ'.repeat(budget.text.rationale + 1),
    });
    expect(result.success).toBe(true);
  });
});

describe('buildJudgeOutputSchema', () => {
  const valid = (n: number) => ({
    images: Array.from({ length: n }, () => ({ score: 0.5, issues: ['指が崩れている'] })),
    nextChange: 'もっと逆光に',
    canStop: false,
  });

  it('requires exactly one evaluation per image', () => {
    const schema = buildJudgeOutputSchema(2);
    expect(schema.safeParse(valid(2)).success).toBe(true);
    expect(schema.safeParse(valid(1)).success).toBe(false);
    expect(schema.safeParse(valid(3)).success).toBe(false);
  });

  it('accepts more and longer issues than the input budget carries', () => {
    const output = valid(1);
    output.images[0] = {
      score: 0.5,
      issues: Array.from({ length: budget.issuesPerImage + 1 }, () =>
        'x'.repeat(budget.text.issue + 1),
      ),
    };
    expect(buildJudgeOutputSchema(1).safeParse(output).success).toBe(true);
  });

  it.each([[-0.1], [1.5]])('rejects a score of %d, outside 0 to 1', (score) => {
    const output = valid(1);
    output.images[0] = { score, issues: [] };
    expect(buildJudgeOutputSchema(1).safeParse(output).success).toBe(false);
  });

  it.each([[0], [1]])('accepts a score of %d at the edge of 0 to 1', (score) => {
    const output = valid(1);
    output.images[0] = { score, issues: [] };
    expect(buildJudgeOutputSchema(1).safeParse(output).success).toBe(true);
  });

  // 「意図どおり」なのに意図に合っていない点数を付けた出力は、どちらかが誤り。止めてよいとして読まない
  const judged = (scores: number[], canStop: boolean) => ({
    images: scores.map((score) => ({ score, issues: [] })),
    nextChange: '',
    canStop,
  });

  it.each([[[0]], [[0.49]], [[0.49, 0.2]]])(
    'rejects "can stop" when the best score of %j is below 0.5',
    (scores) => {
      const result = buildJudgeOutputSchema(scores.length).safeParse(judged(scores, true));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['canStop']);
    },
  );

  it.each([[[0.5]], [[0.9]], [[0.2, 0.5]]])(
    'accepts "can stop" when the best score of %j is 0.5 or more',
    (scores) => {
      expect(buildJudgeOutputSchema(scores.length).safeParse(judged(scores, true)).success).toBe(
        true,
      );
    },
  );

  it('accepts a low score that does not say it can stop', () => {
    expect(buildJudgeOutputSchema(1).safeParse(judged([0], false)).success).toBe(true);
  });

  it('keeps the same JSON Schema for the model to follow', () => {
    expect(z.toJSONSchema(buildJudgeOutputSchema(1))).toEqual(
      z.toJSONSchema(buildJudgeRecordSchema(1)),
    );
  });
});

// 検査を入れる前に受け付けた記録（点数が低いまま止めてよいとしたもの）も、読み直せる
describe('buildJudgeRecordSchema', () => {
  it('reads a recorded judgement that said it can stop with a score of 0', () => {
    const recorded = {
      images: [{ score: 0, issues: [] }],
      nextChange: '',
      canStop: true,
    };
    expect(buildJudgeRecordSchema(1).safeParse(recorded).success).toBe(true);
  });
});

describe('THINK_PARAM_KEYS', () => {
  it('holds exactly the five parameters of the M2 range', () => {
    expect([...THINK_PARAM_KEYS]).toEqual([
      'prompt',
      'negativePrompt',
      'seed',
      'steps',
      'cfgScale',
    ]);
  });
});
