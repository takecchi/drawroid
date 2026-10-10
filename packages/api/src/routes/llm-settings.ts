import { createLlm, LlmConfigError, llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { describeIssues, invalidConfig, invalidRequest } from '../errors.js';
import { inWindowCheckLine, windowProblem } from '../input-windows.js';
import { jsonBody } from '../validate.js';

/** 値ではなく、名前と「入っているか」だけを返す */
function apiKeyEnvStatus(config: LlmConfig, env: ApiDeps['env']) {
  const status: Record<string, { name: string; set: boolean }> = {};
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (provider.apiKeyEnv === undefined) continue;
    const value = env[provider.apiKeyEnv];
    status[providerName] = { name: provider.apiKeyEnv, set: value !== undefined && value !== '' };
  }
  return status;
}

export function llmSettingsRoutes(deps: ApiDeps) {
  const view = (config: LlmConfig) => ({ config, apiKeyEnv: apiKeyEnvStatus(config, deps.env) });

  return (
    new Hono()
      .get('/', async (c) => {
        const stored = await deps.llmSettings.read();
        if (stored === undefined) return c.json({ config: null }, 200);
        const parsed = llmConfigSchema.safeParse(stored);
        if (!parsed.success) {
          return invalidConfig(c, describeIssues(parsed.error));
        }
        return c.json(view(parsed.data), 200);
      })
      // validator を通す: 送る本文の型を、画面の側が hono/client から引けるようにするため
      .put('/', jsonBody(llmConfigSchema), async (c) => {
        const config = c.req.valid('json');
        // 組み立てられない設定は保存しない: 保存した設定と実際に使う設定がずれ、走っているジョブが次の呼び出しで止まるため
        try {
          createLlm(config, { env: deps.env });
        } catch (error) {
          const reason = error instanceof LlmConfigError ? error.message : 'LLM を組み立てられない';
          return invalidRequest(c, reason);
        }
        // 窓が今の予算に足りない設定は保存しない: 保存すると、ジョブが入力を組む段で必ず止まるため（architecture の予算）
        const problem = await inWindowCheckLine(deps, async () => {
          const found = await windowProblem(
            deps,
            (await deps.budgetSettings.read()).effective,
            config,
          );
          if (found === undefined) await deps.llmSettings.write(config);
          return found;
        });
        if (problem !== undefined) return invalidRequest(c, problem);
        return c.json(view(config), 200);
      })
  );
}
