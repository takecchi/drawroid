import { DEFAULT_BUDGETS, estimateMaxOutputTokens, type Budgets } from '@drawroid/core';
import {
  createLlm,
  LlmConfigError,
  llmConfigSchema,
  outputLimitWarnings,
  type LlmConfig,
} from '@drawroid/llm';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { describeIssues, invalidConfig, invalidRequest } from '../errors.js';
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
  // 予算の設定が壊れていても LLM の設定は読めるようにする: 警告のための見積もりに、LLM の設定の画面ごと巻き込まないため
  const currentBudgets = (): Promise<Budgets> =>
    deps.budgetSettings.read().then(
      ({ effective }) => effective,
      () => DEFAULT_BUDGETS,
    );
  // 今の設定の予算で見積もる: これから投入するジョブは、この予算で回るため
  const view = async (config: LlmConfig) => ({
    config,
    apiKeyEnv: apiKeyEnvStatus(config, deps.env),
    // 保存済みの値が小さいまま残っていても気づけるように、読むたびに見積もりと比べて返す
    outputLimitWarnings: outputLimitWarnings(
      config,
      estimateMaxOutputTokens(await currentBudgets()),
    ),
  });

  return (
    new Hono()
      .get('/', async (c) => {
        const stored = await deps.llmSettings.read();
        if (stored === undefined) return c.json({ config: null }, 200);
        const parsed = llmConfigSchema.safeParse(stored);
        if (!parsed.success) {
          return invalidConfig(c, describeIssues(parsed.error));
        }
        return c.json(await view(parsed.data), 200);
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
        await deps.llmSettings.write(config);
        return c.json(await view(config), 200);
      })
  );
}
