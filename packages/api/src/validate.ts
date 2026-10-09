import type { MiddlewareHandler } from 'hono';
import { validator } from 'hono/validator';
import type { z } from 'zod';

import { describeIssues, invalidRequest } from './errors.js';

function validateJson<T extends z.ZodType>(schema: T) {
  return validator('json', (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return invalidRequest(c, describeIssues(parsed.error));
    return parsed.data as z.output<T>;
  });
}

type ValidateJson<T extends z.ZodType> = ReturnType<typeof validateJson<T>>;

/** 送る本文の型（in）だけを、validator の変換の前の型に差し替える。検証のあとの型（out）と応答の型はそのまま */
type WithRequestBody<M, Body> =
  M extends MiddlewareHandler<infer E, infer P, infer I, infer R>
    ? MiddlewareHandler<E, P, Omit<I, 'in'> & { in: { json: Body } }, R>
    : never;

/**
 * JSON の本文を zod のスキーマで検証する。通らなければ、ほかのルートと同じ形の 400 を返す。
 * hono/client が推論する「送る本文の型」は、スキーマの入力の型（z.input）になる。
 */
// ハンドラの中で safeParse しない: hono の validator を通すと、AppType から本文の型が出て、画面の側で送る本文に型が付くため。
// 送る本文の型をここで差し替える: hono は validator の変換のあとの型で送る本文を推論し、base64 の文字列をバイト列に戻す
// ような変換を挟んだ口では、画面の側が送る本文の型と合わなくなる。型を合わせる場所を、画面の側の各所ではなくここ1か所にする（Issue #45）
export function jsonBody<T extends z.ZodType>(
  schema: T,
): WithRequestBody<ValidateJson<T>, z.input<T>> {
  return validateJson(schema) as unknown as WithRequestBody<ValidateJson<T>, z.input<T>>;
}
