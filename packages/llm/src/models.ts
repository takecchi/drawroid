import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderConfig, RoleConfig } from './config.js';

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
