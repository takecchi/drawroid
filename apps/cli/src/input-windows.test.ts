import { llmConfigSchema, type LlmConfig } from '@drawroid/llm';
import { describe, expect, it } from 'vitest';

import { createInputWindows } from './input-windows.js';

const llm = (roles: Record<string, unknown>): LlmConfig =>
  llmConfigSchema.parse({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
    roles,
  });

// detected は LLM から読めた窓。読めなかった役は contextTokens を埋めずに返す
function setup(current?: LlmConfig, detected: Partial<Record<'think' | 'judge', number>> = {}) {
  const lines: string[] = [];
  const detectCalls: LlmConfig[] = [];
  const windows = createInputWindows({
    current: () => current,
    detect: async (config) => {
      detectCalls.push(config);
      const roles = Object.fromEntries(
        Object.entries(config.roles).map(([role, value]) => [
          role,
          { ...value, contextTokens: value.contextTokens ?? detected[role as 'think' | 'judge'] },
        ]),
      );
      return { ...config, roles } as LlmConfig;
    },
    log: (line) => lines.push(line),
  });
  return { windows, lines, detectCalls };
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

  it('compares against the window read from the LLM when the passed settings leave contextTokens out', async () => {
    const { windows, lines } = setup(undefined, { think: 8192 });
    const config = llm({ think: { provider: 'local', model: 'm' } });

    expect(await windows(config)).toEqual({
      think: { contextTokens: 8192, maxOutputTokens: 1024 },
      judge: { contextTokens: 8192, maxOutputTokens: 1024 },
    });
    expect(lines).toEqual([]);
  });

  it('leaves out a passed role whose window could not be read, and says so', async () => {
    const { windows, lines } = setup(undefined, { think: 8192 });
    const config = llm({
      think: { provider: 'local', model: 'm' },
      judge: { provider: 'local', model: 'v' },
    });

    expect(await windows(config)).toEqual({
      think: { contextTokens: 8192, maxOutputTokens: 1024 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('見る役');
    expect(lines[0]).toContain('比べなかった');
  });

  it('does not read from the LLM for the settings in effect, which already carry the read windows', async () => {
    const current = llm({ think: { provider: 'local', model: 'm', contextTokens: 2048 } });
    const { windows, detectCalls } = setup(current, { think: 9999 });

    expect((await windows()).think).toEqual({ contextTokens: 2048, maxOutputTokens: 1024 });
    expect(detectCalls).toEqual([]);
  });
});
