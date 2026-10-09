import { validator } from 'hono/validator';
import type { z } from 'zod';

import { describeIssues, invalidRequest } from './errors.js';

/**
 * JSON の本文を zod のスキーマで検証する。通らなければ、ほかのルートと同じ形の 400 を返す。
 */
// ハンドラの中で safeParse しない: hono の validator を通すと、AppType から本文の型が出て、画面の側で送る本文に型が付くため
export function jsonBody<T extends z.ZodType>(schema: T) {
  return validator('json', (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return invalidRequest(c, describeIssues(parsed.error));
    return parsed.data as z.output<T>;
  });
}
