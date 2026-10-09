import { createLlm, LlmConfigError, llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { describeIssues, errorBody } from '../errors.js';

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

  return new Hono()
    .get('/', async (c) => {
      const stored = await deps.llmSettings.read();
      if (stored === undefined) return c.json({ config: null }, 200);
      const parsed = llmConfigSchema.safeParse(stored);
      if (!parsed.success) {
        return c.json(errorBody('invalid_config', describeIssues(parsed.error)), 500);
      }
      return c.json(view(parsed.data), 200);
    })
    .put('/', async (c) => {
      const parsed = llmConfigSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        return c.json(errorBody('invalid_request', describeIssues(parsed.error)), 400);
      }
      // 組み立てられない設定は保存しない: 保存した設定と実際に使う設定がずれ、走っているジョブが次の呼び出しで止まるため
      try {
        createLlm(parsed.data, { env: deps.env });
      } catch (error) {
        const reason = error instanceof LlmConfigError ? error.message : 'LLM を組み立てられない';
        return c.json(errorBody('invalid_request', reason), 400);
      }
      await deps.llmSettings.write(parsed.data);
      return c.json(view(parsed.data), 200);
    });
}
