import type { LlmPort } from '@drawroid/core';
import { AiSdkLlm, type AdapterOptions } from './adapter.js';
import { llmConfigSchema, resolveRoles, type LlmConfig } from './config.js';
import { createLanguageModel, type ModelEnvironment } from './models.js';

export { AiSdkLlm, extractJson, type AdapterOptions, type RoleModels } from './adapter.js';
export * from './config.js';
export { createLanguageModel, LlmConfigError, type ModelEnvironment } from './models.js';

/** 設定から LlmPort を組み立てる。設定は llmConfigSchema で検証してから渡す */
export function createLlm(
  input: unknown,
  environment: ModelEnvironment,
  options: Pick<AdapterOptions, 'now'> = {},
): LlmPort {
  const config: LlmConfig = llmConfigSchema.parse(input);
  const roles = resolveRoles(config);
  const modelOf = (role: 'think' | 'judge') => {
    const providerName = roles[role].provider;
    const provider = config.providers[providerName];
    // superRefine で確かめ済み。型の上で undefined が外れないので明示する
    if (provider === undefined) throw new Error(`provider「${providerName}」が無い`);
    return {
      providerName,
      model: createLanguageModel(providerName, provider, roles[role], environment),
    };
  };
  return new AiSdkLlm(
    roles,
    { think: modelOf('think'), judge: modelOf('judge') },
    {
      validationRetries: config.validationRetries,
      networkRetries: config.networkRetries,
      ...options,
    },
  );
}
export { MASKED_SECRET, maskSecrets, restoreMaskedSecrets } from './secrets.js';
