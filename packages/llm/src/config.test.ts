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

  it('uses the thinking model for the talking role by default, even when the judging role has its own', () => {
    const config = llmConfigSchema.parse({
      ...base,
      providers: {
        ...base.providers,
        cloud: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      roles: { ...base.roles, judge: { provider: 'cloud', model: 'claude-haiku-5-5' } },
    });
    const roles = resolveRoles(config);
    expect(roles.talk).toEqual(roles.think);
  });

  it('lets the talking role have its own model', () => {
    const roles = resolveRoles(
      llmConfigSchema.parse({
        ...base,
        roles: { ...base.roles, talk: { provider: 'local', model: 'qwen2.5:14b' } },
      }),
    );
    expect(roles.talk).toMatchObject({ model: 'qwen2.5:14b' });
    expect(roles.think).toMatchObject({ model: 'qwen2.5vl:7b' });
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

  it('names the role, the name it was given and the providers that exist when the name is wrong', () => {
    const result = llmConfigSchema.safeParse({
      ...base,
      providers: {
        ...base.providers,
        cloud: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      roles: { think: { provider: 'local', model: 'x' }, judge: { provider: 'locl', model: 'x' } },
    });
    expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['roles', 'judge', 'provider'],
        message: '見る役の provider「locl」が、定義した provider（local・cloud）に無い',
      },
    ]);
    expect(result.error?.issues[0]?.message).not.toContain('providers に無い');
  });

  it('names the talking role as the talking role when its provider name is wrong', () => {
    const result = llmConfigSchema.safeParse({
      ...base,
      roles: { ...base.roles, talk: { provider: 'locl', model: 'x' } },
    });
    expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['roles', 'talk', 'provider'],
        message: '話す役の provider「locl」が、定義した provider（local）に無い',
      },
    ]);
  });

  it('says no provider is defined yet when the list is empty', () => {
    const result = llmConfigSchema.safeParse({ providers: {}, roles: base.roles });
    expect(result.error?.issues[0]?.message).toBe(
      '考える役の provider「local」が、定義した provider（まだ無い）に無い',
    );
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

  it('fills the defaults of a role', () => {
    expect(llmConfigSchema.parse(base).roles.think).toEqual({
      provider: 'local',
      model: 'qwen2.5vl:7b',
      structuredOutput: 'native',
      reasoning: 'native',
      toolCalling: 'native',
      imageInput: true,
    });
  });
});
