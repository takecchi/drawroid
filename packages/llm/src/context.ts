import type { LlmRole } from '@drawroid/core';
import { z } from 'zod';

import type { LlmConfig, ProviderConfig } from './config.js';
import type { ModelEnvironment } from './models.js';

const DETECT_TIMEOUT_MS = 5000;

// llama.cpp の /v1/models は、読み込んだモデルの窓を meta.n_ctx に載せる。OpenAI の形には無い拡張なので、無ければ読まない。
// 一覧の欄はモデルごとに確かめる: ほかのモデルの欄が崩れていても（読み込んでいないモデルの窓が null・0 など）、そのモデルの窓は読むため
const modelsResponseSchema = z.object({ data: z.array(z.unknown()) });
const modelEntrySchema = z.object({ id: z.string() });
const modelWindowSchema = z.object({ meta: z.object({ n_ctx: z.number().int().positive() }) });

/** onlyModel は、名前の合うモデルが無く、一覧に1つだけあるモデルの窓を読んだときの、そのモデルの id */
export type DetectedContext = { role: LlmRole; contextTokens: number; onlyModel?: string };

/** 起動の端末に出す1行 */
export function describeDetectedContext({
  role,
  contextTokens,
  onlyModel,
}: DetectedContext): string {
  const line = `drawroid: ${role} の役の文脈の上限を LLM から読んだ: ${contextTokens}`;
  return onlyModel === undefined
    ? line
    : `${line}（/v1/models に1つだけあるモデル ${onlyModel} の窓。設定のモデル名とは一致しない）`;
}

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
    const read = await readContextTokens(provider, roleConfig.model, environment);
    if (read === undefined) continue;
    roles[role] = { ...roleConfig, contextTokens: read.contextTokens };
    detected.push({ role, ...read });
  }
  return { config: { ...config, roles: { ...config.roles, ...roles } }, detected };
}

async function readContextTokens(
  provider: ProviderConfig,
  model: string,
  environment: ModelEnvironment,
): Promise<Omit<DetectedContext, 'role'> | undefined> {
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
    const entries = parsed.data.data;
    const named = entries.find(
      (candidate) => modelEntrySchema.safeParse(candidate).data?.id === model,
    );
    if (named !== undefined) {
      const contextTokens = modelWindowSchema.safeParse(named).data?.meta.n_ctx;
      return contextTokens === undefined ? undefined : { contextTokens };
    }
    // 名前が合わなくても、一覧に1つだけなら読む: llama.cpp の llama-server は --alias が無いと id にファイルのパスを出し、
    // チャットは名前を問わずその1つで答えるため。複数あるときは、どれが答えるか分からないので読まない
    const only = entries.length === 1 ? modelEntrySchema.safeParse(entries[0]).data : undefined;
    const contextTokens = modelWindowSchema.safeParse(entries[0]).data?.meta.n_ctx;
    return only === undefined || contextTokens === undefined
      ? undefined
      : { contextTokens, onlyModel: only.id };
  } catch {
    // 読めないことは失敗にしない: 窓の長さを報告しない provider でも、既定の窓で動かすため
    return undefined;
  }
}
