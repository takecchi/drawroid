import type { ZodError } from 'zod';

type Issue = ZodError['issues'][number];

/**
 * 壊れた config.json の文。起動・doctor・API が同じ言い方をするため、ここに1つだけ置く。
 * 日本語の説明を前に、node・zod の原文を括弧で後ろに残す（原文は、調べるときの手がかりになる）。
 * API の入力の 400 は describeInputIssues（入力の欄を言う）で、これは config.json の欄を言う
 */
export function describeConfigIssues(error: ZodError, root: readonly string[] = []): string {
  return error.issues.map((issue) => describeConfigIssue(issue, root)).join('; ');
}

/** root は、検証した値が config.json のどの欄の下かを言う（llm だけを検証したなら ['llm']） */
export function describeConfigIssue(issue: Issue, root: readonly string[] = []): string {
  const path = [...root, ...issue.path.map(String)];
  // 自前の日本語の文には、原文を付けない: すでに人が読める文で、括弧を足すと同じことを2度言う。
  // issue の種類（custom・too_small など）では分けない: .min(1, '日本語の文') も自前の文のため
  if (JAPANESE.test(issue.message)) {
    return describeConfigNote(issue.message, path);
  }
  return `config.json の ${fieldName(path)} が読めない（${explain(issue)}）（原文: ${issue.message}）`;
}

/**
 * API の入力の誤り（400）の文。config.json の文と同じく、日本語の説明を前に、zod の原文を括弧で後ろに置く。
 * 欄は入力の道筋（値が無い道筋は (body)）。config.json の欄ではないので「config.json の」は付けない。
 * 入力の値は文に含めない: 値が API キーなどの秘密でも、応答に出さないため
 */
export function describeInputIssues(error: ZodError): string {
  return error.issues.map(describeInputIssue).join('; ');
}

function describeInputIssue(issue: Issue): string {
  const field = fieldName(issue.path.map(String), '(body)');
  if (JAPANESE.test(issue.message)) return `${field}: ${issue.message}`;
  return `${field} の値が違う（${explain(issue)}）（原文: ${issue.message}）`;
}

/** zod の issue が無い、自前の日本語の1文（予算の「欄の集まりになっていない」など）を、同じ形で言う */
export function describeConfigNote(note: string, path: readonly string[] = []): string {
  return `config.json の ${fieldName(path)}: ${note}`;
}

function fieldName(path: readonly string[], whenEmpty = '(全体)'): string {
  return path.join('.') || whenEmpty;
}

/** JSON として読めないときは、欄を言えない（全体が読めていない）。ファイルのパスは呼び手が添える */
export function describeUnparsableConfig(message: string): string {
  return `config.json が JSON として読めない（原文: ${message}）`;
}

/**
 * config.json が JSON として読めなかった失敗。node の原文を持つ。
 * 読んだ置き場（storage-fs）と、文にして返す口（api）が別の層のため、層をまたいで見分けられる型にする
 */
export class UnparsableConfigError extends Error {
  constructor(
    readonly original: string,
    options?: ErrorOptions,
  ) {
    super(describeUnparsableConfig(original), options);
    this.name = 'UnparsableConfigError';
  }
}

const JAPANESE = /[぀-ヿ㐀-鿿]/u;

const EXPECTED_TYPES: Readonly<Record<string, string>> = {
  string: '文字列で書く',
  number: '数で書く',
  int: '整数で書く',
  boolean: 'true か false で書く',
  object: '{ … } の形で書く',
  record: '{ … } の形で書く',
  array: '[ … ] の形で書く',
  tuple: '[ … ] の形で書く',
};

function explain(issue: Issue): string {
  switch (issue.code) {
    case 'invalid_type':
      if (/received undefined$/.test(issue.message)) return '欄が無い';
      return EXPECTED_TYPES[issue.expected] ?? OTHER;
    case 'invalid_value':
      return oneOf(issue.values.map((value) => JSON.stringify(value)));
    case 'invalid_format':
      return issue.format === 'url'
        ? 'http:// などで始まる URL で書く'
        : `${issue.format} の形で書く`;
    case 'too_small':
      return bound(issue.origin, String(issue.minimum), issue.inclusive !== false, '以上');
    case 'too_big':
      return bound(issue.origin, String(issue.maximum), issue.inclusive !== false, '以下');
    case 'unrecognized_keys':
      return `知らない欄 ${issue.keys.join('・')}`;
    default:
      return OTHER;
  }
}

const OTHER = '書き方が違う';

function oneOf(values: readonly string[]): string {
  if (values.length === 1) return `${values[0]} と書く`;
  if (values.length === 2) return `${values[0]} か ${values[1]} のどちらか`;
  return `${values.join('・')} のどれか`;
}

function bound(origin: string, n: string, inclusive: boolean, word: '以上' | '以下'): string {
  switch (origin) {
    case 'string':
      return `${n} 文字${word}`;
    case 'array':
    case 'set':
      return `${n} 個${word}`;
    case 'number':
    case 'int':
    case 'bigint':
      // positive()（0 を含まない）は「0 以上」と言うと誤る
      return inclusive ? `${n} ${word}` : `${n} より${word === '以上' ? '大きい' : '小さい'}`;
    default:
      return OTHER;
  }
}
