import { describe, expect, it } from 'vitest';

import { llmConfigSchema } from './config.js';
import { detectContextTokens } from './context.js';

const config = (contextTokens?: number) =>
  llmConfigSchema.parse({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:8080/v1/' } },
    roles: {
      think: { provider: 'local', model: 'qwen', ...(contextTokens && { contextTokens }) },
    },
  });

function modelsFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

describe('detectContextTokens', () => {
  it('fills the context length the server reports for the model', async () => {
    const { fetch, urls } = modelsFetch({
      data: [
        { id: 'other', meta: { n_ctx: 4096 } },
        { id: 'qwen', meta: { n_ctx: 32768 } },
      ],
    });
    const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });
    expect(filled.roles.think.contextTokens).toBe(32768);
    expect(detected).toEqual([{ role: 'think', contextTokens: 32768 }]);
    expect(urls).toEqual(['http://127.0.0.1:8080/v1/models']);
  });

  it('keeps the configured context length without asking the server', async () => {
    const { fetch, urls } = modelsFetch({ data: [{ id: 'qwen', meta: { n_ctx: 32768 } }] });
    const { config: filled } = await detectContextTokens(config(4096), { env: {}, fetch });
    expect(filled.roles.think.contextTokens).toBe(4096);
    expect(urls).toEqual([]);
  });

  it.each([
    ['the server does not report it', modelsFetch({ data: [{ id: 'qwen' }] })],
    ['the server fails', modelsFetch({ error: 'down' }, 500)],
  ])('leaves it unset when %s', async (_, { fetch }) => {
    const { config: filled, detected } = await detectContextTokens(config(), { env: {}, fetch });
    expect(filled.roles.think.contextTokens).toBeUndefined();
    expect(detected).toEqual([]);
  });
});
