import { Hono } from 'hono';
import { z } from 'zod';

import type { ApiDeps } from '../deps.js';
import { conflict, describeIssues, invalidRequest } from '../errors.js';
import { LlmNotConfiguredError } from '../stop-condition-parse.js';

const bodySchema = z.object({
  text: z.string().refine((text) => text.trim().length > 0, { message: '止める条件の文が空' }),
});

/** 止める条件の自然言語を案に変換する。案を返すだけで、何も保存しない */
export function stopConditionParseRoutes({ stopConditionParser }: ApiDeps) {
  return new Hono().post('/parse', async (c) => {
    const body = bodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return invalidRequest(c, describeIssues(body.error));
    try {
      const draft = await stopConditionParser.parse(body.data.text, c.req.raw.signal);
      if (!draft.ok) {
        return c.json({ error: { kind: 'unparsable' as const, message: draft.reason } }, 422);
      }
      return c.json({ draft }, 200);
    } catch (error) {
      if (error instanceof LlmNotConfiguredError) {
        return conflict(c, 'llm_not_configured', error.message);
      }
      throw error;
    }
  });
}
