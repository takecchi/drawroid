import { llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import { describe, expect, it } from 'vitest';

import { createInputWindows } from './input-windows.js';

const llm = (roles: Record<string, unknown>): LlmConfig =>
  llmConfigSchema.parse({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
    roles,
  });

function setup(current?: LlmConfig) {
  const lines: string[] = [];
  const windows = createInputWindows({ current: () => current, log: (line) => lines.push(line) });
  return { windows, lines };
}

describe('createInputWindows', () => {
  it('gives the windows written in the settings, the judging role taking the thinking role window when it is left out', async () => {
    const { windows, lines } = setup();
    const config = llm({
      think: { provider: 'local', model: 'm', contextTokens: 4096, maxOutputTokens: 512 },
    });

    expect(await windows(config)).toEqual({
      think: { contextTokens: 4096, maxOutputTokens: 512 },
      judge: { contextTokens: 4096, maxOutputTokens: 512 },
    });
    expect(lines).toEqual([]);
  });

  it('leaves out a role whose window is not known, and says so in one line', async () => {
    const { windows, lines } = setup();
    const config = llm({
      think: { provider: 'local', model: 'm', contextTokens: 4096 },
      judge: { provider: 'local', model: 'v' },
    });

    expect(await windows(config)).toEqual({
      think: { contextTokens: 4096, maxOutputTokens: 1024 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('見る役');
    expect(lines[0]).toContain('比べなかった');
  });

  it('gives nothing and says so when no LLM is set', async () => {
    const { windows, lines } = setup();

    expect(await windows()).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('比べなかった');
  });

  it('gives the windows of the settings in effect when none are passed', async () => {
    const current = llm({ think: { provider: 'local', model: 'm', contextTokens: 2048 } });
    const { windows } = setup(current);

    expect((await windows()).think).toEqual({ contextTokens: 2048, maxOutputTokens: 1024 });
  });
});
