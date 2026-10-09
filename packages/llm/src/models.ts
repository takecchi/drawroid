import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import type { ProviderConfig, RoleConfig } from './config.js';

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

export type ModelEnvironment = {
  env: Readonly<Record<string, string | undefined>>;
  /** 試験で HTTP を差し替えるため */
  fetch?: typeof globalThis.fetch;
};

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

function resolveApiKey(
  provider: ProviderConfig,
  environment: ModelEnvironment,
): string | undefined {
  if (provider.apiKeyEnv === undefined) return undefined;
  const value = environment.env[provider.apiKeyEnv];
  // 値ではなく変数の名前だけを出す: エラーはログと UI に出るため
  if (value === undefined || value === '') {
    throw new LlmConfigError(`環境変数 ${provider.apiKeyEnv} に API キーが入っていない`);
  }
  return value;
}

export function createLanguageModel(
  providerName: string,
  provider: ProviderConfig,
  role: RoleConfig,
  environment: ModelEnvironment,
): LanguageModel {
  // AI SDK の既定（OPENAI_API_KEY などを process.env から読む）に任せない: 保存の時点で確かめられず、呼び出すまで失敗が見えないため
  if (provider.type !== 'openai-compatible' && provider.apiKeyEnv === undefined) {
    throw new LlmConfigError(
      `provider「${providerName}」（${provider.type}）は apiKeyEnv で API キーの環境変数を指す`,
    );
  }
  const model = createBaseModel(providerName, provider, role, environment);
  // 本文に混ざる <think> を、AI SDK のミドルウェアで思考の部品に分ける（ストリームにもストリームでない呼び出しにも効く）
  return role.reasoning === 'think-tag'
    ? wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: 'think' }) })
    : model;
}

function createBaseModel(
  providerName: string,
  provider: ProviderConfig,
  role: RoleConfig,
  environment: ModelEnvironment,
): WrappableModel {
  const apiKey = resolveApiKey(provider, environment);
  const fetch = environment.fetch;
  switch (provider.type) {
    case 'openai-compatible':
      return createOpenAICompatible({
        name: providerName,
        baseURL: provider.baseURL,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(fetch === undefined ? {} : { fetch }),
        includeUsage: true,
        // false のままだと JSON Schema を送らず json_object になる。native のときだけ送る
        supportsStructuredOutputs: role.structuredOutput === 'native',
      })(role.model);
    case 'openai':
      return createOpenAI({
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(fetch === undefined ? {} : { fetch }),
      })(role.model);
    case 'anthropic':
      return createAnthropic({
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(fetch === undefined ? {} : { fetch }),
      })(role.model);
  }
}
