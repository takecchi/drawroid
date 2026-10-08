import { describe, expect, it } from 'vitest';
import { llmConfigSchema, resolveRoles } from './config.js';

const base = {
  providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
  roles: { think: { provider: 'local', model: 'qwen2.5vl:7b' } },
};

describe('llmConfigSchema', () => {
  it('uses the thinking model for the judging role by default', () => {
    const roles = resolveRoles(llmConfigSchema.parse(base));
    expect(roles.judge).toEqual(roles.think);
  });

  it('lets each role have its own provider and model', () => {
    const config = llmConfigSchema.parse({
      ...base,
      providers: {
        ...base.providers,
        cloud: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      roles: { ...base.roles, judge: { provider: 'cloud', model: 'claude-haiku-5-5' } },
    });
    const roles = resolveRoles(config);
    expect(roles.think.provider).toBe('local');
    expect(roles.judge).toMatchObject({ provider: 'cloud', model: 'claude-haiku-5-5' });
  });

  it('rejects a role that points at a provider that is not configured', () => {
    const result = llmConfigSchema.safeParse({
      ...base,
      roles: { think: { provider: 'missing', model: 'x' } },
    });
    expect(result.success).toBe(false);
  });

  it('fills the defaults of a role', () => {
    expect(llmConfigSchema.parse(base).roles.think).toEqual({
      provider: 'local',
      model: 'qwen2.5vl:7b',
      contextTokens: 8192,
      maxOutputTokens: 1024,
      structuredOutput: 'native',
      imageInput: true,
    });
  });
});
