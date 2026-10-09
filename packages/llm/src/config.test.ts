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

  it('rejects a provider that carries an API key value instead of an env var name', () => {
    const result = llmConfigSchema.safeParse({
      ...base,
      providers: { local: { ...base.providers.local, apiKey: 'sk-should-not-leak' } },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['openai', {}],
    ['anthropic', {}],
    ['openai-compatible', { baseURL: 'http://127.0.0.1:11434/v1' }],
  ])('rejects an API key value on a %s provider', (type, extra) => {
    const result = llmConfigSchema.safeParse({
      ...base,
      providers: { local: { type, ...extra, apiKey: 'sk-should-not-leak' } },
    });
    expect(result.success).toBe(false);
  });

  it('keeps the output limit below the context limit, defaulting to the smaller of 4096 and half the context', () => {
    const think = (role: object) =>
      llmConfigSchema.safeParse({
        ...base,
        roles: { think: { provider: 'local', model: 'm', ...role } },
      });
    const parsed = (role: object) => {
      const result = think(role);
      if (!result.success) throw new Error(result.error.message);
      return result.data.roles.think.maxOutputTokens;
    };
    expect(parsed({})).toBe(4096);
    expect(parsed({ contextTokens: 4096 })).toBe(2048);
    expect(parsed({ contextTokens: 32768 })).toBe(4096);
    expect(parsed({ contextTokens: 32768, maxOutputTokens: 16384 })).toBe(16384);
    expect(think({ contextTokens: 4096, maxOutputTokens: 4096 }).success).toBe(false);
  });

  it('fills the defaults of a role', () => {
    expect(llmConfigSchema.parse(base).roles.think).toEqual({
      provider: 'local',
      model: 'qwen2.5vl:7b',
      contextTokens: 8192,
      maxOutputTokens: 4096,
      structuredOutput: 'native',
      imageInput: true,
    });
  });
});
