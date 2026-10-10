import type { LlmRole } from '@drawroid/core';
import { z } from 'zod';

import type { LlmConfig, ProviderConfig } from './config.js';
import type { ModelEnvironment } from './models.js';

const DETECT_TIMEOUT_MS = 5000;

// llama.cpp の /v1/models は、読み込んだモデルの窓を meta.n_ctx に載せる。OpenAI の形には無い拡張なので、無ければ読まない
const modelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      meta: z.object({ n_ctx: z.number().int().positive() }).partial().optional(),
    }),
  ),
});

export type DetectedContext = { role: LlmRole; contextTokens: number };

/**
 * contextTokens を書いていない役について、provider が報告する窓の長さを読んで埋める。
 * 読めなければ埋めずに残す（adapter が既定の窓を使う）。
 * 書いていない役（judge・talk を省いたとき）は作り足さない: 省いた役は考える役に従い、その窓も考える役から受けるため
 */
export async function detectContextTokens(
  config: LlmConfig,
  environment: ModelEnvironment,
): Promise<{ config: LlmConfig; detected: DetectedContext[] }> {
  const detected: DetectedContext[] = [];
  const roles = { ...config.roles };
  for (const role of ['think', 'judge', 'talk'] as const) {
    const roleConfig = roles[role];
    if (roleConfig === undefined || roleConfig.contextTokens !== undefined) continue;
    const provider = config.providers[roleConfig.provider];
    if (provider === undefined) continue;
    const contextTokens = await readContextTokens(provider, roleConfig.model, environment);
    if (contextTokens === undefined) continue;
    roles[role] = { ...roleConfig, contextTokens };
    detected.push({ role, contextTokens });
  }
  return { config: { ...config, roles: { ...config.roles, ...roles } }, detected };
}

async function readContextTokens(
  provider: ProviderConfig,
  model: string,
  environment: ModelEnvironment,
): Promise<number | undefined> {
  if (provider.type !== 'openai-compatible') return undefined;
  const apiKey = provider.apiKeyEnv === undefined ? undefined : environment.env[provider.apiKeyEnv];
  const fetch = environment.fetch ?? globalThis.fetch;
  try {
    const response = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/models`, {
      ...(apiKey === undefined || apiKey === ''
        ? {}
        : { headers: { authorization: `Bearer ${apiKey}` } }),
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const parsed = modelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) return undefined;
    return parsed.data.data.find((entry) => entry.id === model)?.meta?.n_ctx;
  } catch {
    // 読めないことは失敗にしない: 窓の長さを報告しない provider でも、既定の窓で動かすため
    return undefined;
  }
}
