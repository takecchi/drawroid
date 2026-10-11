import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeConfigIssues, describeUnparsableConfig } from './config-problems.js';

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

  it('falls back to "書き方が違う" for the other kinds', () => {
    const schema = z.object({ f: z.string().regex(/^a$/) });
    expect(said(schema, { f: 'b' })).toContain('（書き方が違う）');
  });

  it('does not put the original message after a custom message that is already Japanese', () => {
    const schema = z
      .object({ backend: z.object({ url: z.string().optional() }) })
      .refine(() => false, { path: ['backend'], message: 'backend の url と forgeUrl が両方ある' });
    expect(said(schema, { backend: {} })).toBe(
      'config.json の backend: backend の url と forgeUrl が両方ある',
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

describe('describeUnparsableConfig', () => {
  it('says it is not JSON and keeps the original message in parentheses, with no field name', () => {
    expect(describeUnparsableConfig("Expected property name or '}' in JSON at position 1")).toBe(
      "config.json が JSON として読めない（原文: Expected property name or '}' in JSON at position 1）",
    );
  });
});
