import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmConfig } from '@drawroid/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLlmSettings, LLM_SETTINGS_LOADED } from './llm-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-cli-llm-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const llm = {
  providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
  roles: { think: { provider: 'local', model: 'qwen' } },
} as unknown as LlmConfig;

describe('LLM settings of the CLI', () => {
  it('says the settings were loaded once they are saved and in effect', async () => {
    const steps: string[] = [];
    const settings = createLlmSettings({
      configPath,
      configure: async () => {
        steps.push('configure');
      },
      kick: () => steps.push('kick'),
      log: (line) => steps.push(line),
    });

    await settings.write(llm);

    expect(steps).toEqual(['configure', LLM_SETTINGS_LOADED, 'kick']);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ llm });
  });

  it('does not say the settings were loaded when putting them in effect fails', async () => {
    const lines: string[] = [];
    const settings = createLlmSettings({
      configPath,
      configure: () => Promise.reject(new Error('窓を読めない')),
      kick: () => undefined,
      log: (line) => lines.push(line),
    });

    await expect(settings.write(llm)).rejects.toThrow('窓を読めない');
    expect(lines).not.toContain(LLM_SETTINGS_LOADED);
  });

  it('reads back what was saved', async () => {
    const settings = createLlmSettings({
      configPath,
      configure: async () => undefined,
      kick: () => undefined,
      log: () => undefined,
    });

    await settings.write(llm);

    expect(await settings.read()).toEqual(llm);
  });
});
