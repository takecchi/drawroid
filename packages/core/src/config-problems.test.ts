import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  describeConfigIssues,
  describeInputIssues,
  describeUnparsableConfig,
  UnparsableConfigError,
} from './config-problems.js';

/** schema に value を渡して失敗させ、config.json の文にする */
function said(schema: z.ZodType, value: unknown, root: string[] = []): string {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('この値は通ってしまった');
  return describeConfigIssues(parsed.error, root);
}

describe('describeConfigIssues', () => {
  it('says the field, a Japanese explanation, and the original message in parentheses', () => {
    const kind = z.object({ backend: z.object({ kind: z.enum(['forge', 'a1111']) }) });
    expect(said(kind, { backend: { kind: 'comfyui' } })).toBe(
      'config.json の backend.kind が読めない（"forge" か "a1111" のどちらか）（原文: Invalid option: expected one of "forge"|"a1111"）',
    );
  });

  it('lists three or more allowed values with "のどれか"', () => {
    const schema = z.object({ mode: z.enum(['a', 'b', 'c']) });
    expect(said(schema, { mode: 'x' })).toContain('（"a"・"b"・"c" のどれか）');
  });

  it.each([
    ['a string', z.string(), 1, '文字列で書く'],
    ['a number', z.number(), 'x', '数で書く'],
    ['an integer', z.number().int(), 1.5, '整数で書く'],
    ['a boolean', z.boolean(), 'x', 'true か false で書く'],
    ['an object', z.object({}), 'x', '{ … } の形で書く'],
    ['an array', z.array(z.string()), 'x', '[ … ] の形で書く'],
  ])('explains a value that should be %s', (_, schema, value, explanation) => {
    expect(said(z.object({ f: schema }), { f: value })).toContain(`（${explanation}）`);
  });

  it('says the field is missing when the value is undefined', () => {
    const schema = z.object({ llm: z.object({ roles: z.object({ think: z.object({}) }) }) });
    expect(said(schema, { llm: { roles: {} } })).toBe(
      'config.json の llm.roles.think が読めない（欄が無い）（原文: Invalid input: expected object, received undefined）',
    );
  });

  it('explains a url that is not a url', () => {
    expect(said(z.object({ url: z.url() }), { url: 'not a url' })).toContain(
      '（http:// などで始まる URL で書く）',
    );
  });

  it('names the format of other string formats', () => {
    expect(said(z.object({ id: z.uuid() }), { id: 'x' })).toContain('（uuid の形で書く）');
  });

  it.each([
    ['a short string', z.string().min(3), 'a', '3 文字以上'],
    ['a long string', z.string().max(2), 'abc', '2 文字以下'],
    ['a small number', z.number().min(5), 1, '5 以上'],
    ['a large number', z.number().max(5), 9, '5 以下'],
    ['a short array', z.array(z.string()).min(2), [], '2 個以上'],
    ['a long array', z.array(z.string()).max(1), ['a', 'b'], '1 個以下'],
  ])('explains %s', (_, schema, value, explanation) => {
    expect(said(z.object({ f: schema }), { f: value })).toContain(`（${explanation}）`);
  });

  it('says "greater than" for a number that must be positive', () => {
    expect(said(z.object({ f: z.number().positive() }), { f: 0 })).toContain('（0 より大きい）');
  });

  it('names the unknown fields', () => {
    expect(said(z.strictObject({ a: z.string() }), { a: 'x', b: 1, c: 2 })).toContain(
      '（知らない欄 b・c）',
    );
  });

  it('lists the allowed values of a discriminator', () => {
    const provider = z.discriminatedUnion('type', [
      z.object({ type: z.literal('openai-compatible') }),
      z.object({ type: z.literal('openai') }),
      z.object({ type: z.literal('anthropic') }),
    ]);
    const schema = z.object({ llm: z.object({ providers: z.record(z.string(), provider) }) });
    expect(said(schema, { llm: { providers: { local: { type: 'ollama' } } } })).toBe(
      'config.json の llm.providers.local.type が読めない（"openai-compatible"・"openai"・"anthropic" のどれか）（原文: Invalid discriminator value. Expected \'openai-compatible\' | \'openai\' | \'anthropic\'）',
    );
  });

  it('falls back to "書き方が違う" for the other kinds', () => {
    const schema = z.object({ f: z.number().multipleOf(5) });
    expect(said(schema, { f: 3 })).toContain('（書き方が違う）');
  });

  it('does not put the original message after a custom message that is already Japanese', () => {
    const schema = z
      .object({ backend: z.object({ url: z.string().optional() }) })
      .refine(() => false, { path: ['backend'], message: 'backend の url と forgeUrl が両方ある' });
    expect(said(schema, { backend: {} })).toBe(
      'config.json の backend: backend の url と forgeUrl が両方ある',
    );
  });

  it('does not put the original message after a Japanese message of a kind other than custom', () => {
    const schema = z.object({
      llm: z.object({
        roles: z.object({
          think: z.object({ model: z.string().min(1, '考える役のモデルの名前を入れる') }),
        }),
      }),
    });
    const sentence = said(schema, { llm: { roles: { think: { model: '' } } } });
    expect(sentence).toBe('config.json の llm.roles.think.model: 考える役のモデルの名前を入れる');
    expect(sentence).not.toContain('原文');
  });

  it.each([
    ['hiragana only', 'ひらがなだけ'],
    ['katakana only', 'エラー'],
    ['kanji only', '欄名不正'],
  ])('treats a message of %s as Japanese, custom or not', (_, message) => {
    const custom = z.string().refine(() => false, { message });
    const tooSmall = z.string().min(1, message);
    expect(said(z.object({ f: custom }), { f: 'a' })).toBe(`config.json の f: ${message}`);
    expect(said(z.object({ f: tooSmall }), { f: '' })).toBe(`config.json の f: ${message}`);
  });

  it('keeps the Japanese explanation and the original message for the default English message', () => {
    expect(said(z.object({ f: z.string().min(1) }), { f: '' })).toBe(
      'config.json の f が読めない（1 文字以上）（原文: Too small: expected string to have >=1 characters）',
    );
  });

  it('treats a custom message in English as the fallback', () => {
    const schema = z.string().refine(() => false, { message: 'nope' });
    expect(said(z.object({ f: schema }), { f: 'a' })).toBe(
      'config.json の f が読めない（書き方が違う）（原文: nope）',
    );
  });

  it('puts the root in front of the path, so a section read on its own still names its field', () => {
    expect(said(z.object({ roles: z.object({}) }), {}, ['llm'])).toContain(
      'config.json の llm.roles が読めない',
    );
  });

  it('joins several issues with "; "', () => {
    const sentence = said(z.object({ a: z.string(), b: z.number() }), { a: 1, b: 'x' });
    expect(sentence.split('; ')).toEqual([
      'config.json の a が読めない（文字列で書く）（原文: Invalid input: expected string, received number）',
      'config.json の b が読めない（数で書く）（原文: Invalid input: expected number, received string）',
    ]);
  });

  it('names the whole file when the path is empty', () => {
    expect(said(z.object({}), 'x')).toContain('config.json の (全体) が読めない');
  });
});

/** schema に value を渡して失敗させ、API の入力の誤りの文にする */
function saidOfInput(schema: z.ZodType, value: unknown): string {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('この値は通ってしまった');
  return describeInputIssues(parsed.error);
}

describe('describeInputIssues', () => {
  it('says the input field, a Japanese explanation, and the original message, without naming config.json', () => {
    expect(
      saidOfInput(z.object({ imageLongEdge: z.number().min(128) }), { imageLongEdge: 0 }),
    ).toBe('imageLongEdge の値が違う（128 以上）（原文: Too small: expected number to be >=128）');
  });

  it('joins a nested path with dots', () => {
    const schema = z.object({ text: z.object({ prompt: z.number() }) });
    expect(saidOfInput(schema, { text: { prompt: 'x' } })).toBe(
      'text.prompt の値が違う（数で書く）（原文: Invalid input: expected number, received string）',
    );
  });

  it('names the whole body as (body) when the path is empty', () => {
    expect(saidOfInput(z.strictObject({ a: z.string() }), { a: 'x', nope: 1 })).toBe(
      '(body) の値が違う（知らない欄 nope）（原文: Unrecognized key: "nope"）',
    );
  });

  it('does not put the original message after a custom message that is already Japanese', () => {
    const schema = z.object({ f: z.string().refine(() => false, { message: '空にできない' }) });
    expect(saidOfInput(schema, { f: 'a' })).toBe('f: 空にできない');
  });

  it('does not put the original message after a Japanese message of a kind other than custom', () => {
    const sentence = saidOfInput(z.object({ f: z.string().min(1, '空にできない') }), { f: '' });
    expect(sentence).toBe('f: 空にできない');
    expect(sentence).not.toContain('原文');
  });

  it.each([
    ['hiragana only', 'ひらがなだけ'],
    ['katakana only', 'エラー'],
    ['kanji only', '欄名不正'],
  ])('treats a message of %s as Japanese, custom or not', (_, message) => {
    const custom = z.string().refine(() => false, { message });
    const tooSmall = z.string().min(1, message);
    expect(saidOfInput(z.object({ f: custom }), { f: 'a' })).toBe(`f: ${message}`);
    expect(saidOfInput(z.object({ f: tooSmall }), { f: '' })).toBe(`f: ${message}`);
  });

  it('keeps the Japanese explanation and the original message for the default English message', () => {
    expect(saidOfInput(z.object({ f: z.string().min(1) }), { f: '' })).toBe(
      'f の値が違う（1 文字以上）（原文: Too small: expected string to have >=1 characters）',
    );
  });

  describe('a discriminator', () => {
    const intervention = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('instruction'), text: z.string() }),
      z.object({ kind: z.literal('reference'), image: z.string() }),
    ]);
    const permission = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('auto') }),
      z.object({ mode: z.literal('fixed'), value: z.unknown() }),
      z.object({ mode: z.literal('off') }),
    ]);

    it('says the allowed values in Japanese, not only in the original message', () => {
      expect(saidOfInput(intervention, { kind: 'mask' })).toBe(
        'kind の値が違う（"instruction" か "reference" のどちらか）（原文: Invalid discriminator value. Expected \'instruction\' | \'reference\'）',
      );
    });

    it('lists three or more allowed values on a nested field', () => {
      expect(saidOfInput(z.object({ steps: permission }), { steps: { mode: 'bogus' } })).toBe(
        'steps.mode の値が違う（"auto"・"fixed"・"off" のどれか）（原文: Invalid discriminator value. Expected \'auto\' | \'fixed\' | \'off\'）',
      );
    });

    it('lists the allowed values when the discriminator is missing', () => {
      expect(saidOfInput(intervention, { text: '逆光にして' })).toContain(
        'kind の値が違う（"instruction" か "reference" のどちらか）',
      );
    });

    it('says the one allowed value of a discriminator with a single option', () => {
      const only = z.discriminatedUnion('kind', [z.object({ kind: z.literal('manual') })]);
      expect(saidOfInput(only, { kind: 'auto' })).toContain('kind の値が違う（"manual" と書く）');
    });
  });

  it('falls back to "書き方が違う" for a union without a discriminator', () => {
    expect(saidOfInput(z.object({ f: z.union([z.string(), z.number()]) }), { f: true })).toContain(
      'f の値が違う（書き方が違う）',
    );
  });

  it('joins several issues with "; "', () => {
    expect(
      saidOfInput(z.object({ a: z.string(), b: z.number() }), { a: 1, b: 'x' }).split('; '),
    ).toEqual([
      'a の値が違う（文字列で書く）（原文: Invalid input: expected string, received number）',
      'b の値が違う（数で書く）（原文: Invalid input: expected number, received string）',
    ]);
  });

  it('does not repeat the input value, which may be a secret', () => {
    expect(saidOfInput(z.object({ key: z.number() }), { key: 'sk-secret-value' })).not.toContain(
      'sk-secret-value',
    );
  });
});

describe('describeUnparsableConfig', () => {
  it('says it is not JSON and keeps the original message in parentheses, with no field name', () => {
    expect(describeUnparsableConfig("Expected property name or '}' in JSON at position 1")).toBe(
      "config.json が JSON として読めない（原文: Expected property name or '}' in JSON at position 1）",
    );
  });
});

describe('UnparsableConfigError', () => {
  it('carries the original message, and its own message is the same sentence as describeUnparsableConfig', () => {
    const said = "Expected property name or '}' in JSON at position 1";
    const error = new UnparsableConfigError(said);

    expect(error.original).toBe(said);
    expect(error.message).toBe(describeUnparsableConfig(said));
  });
});
