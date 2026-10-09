import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLlmSettings, writeLlmSettings } from './llm-settings.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-llm-settings-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LLM settings in config.json', () => {
  it('reads nothing when the file does not exist', async () => {
    expect(await readLlmSettings(configPath)).toBeUndefined();
  });

  it('reads nothing when the file has no llm key', async () => {
    await writeFile(configPath, JSON.stringify({ backend: { type: 'forge' } }));
    expect(await readLlmSettings(configPath)).toBeUndefined();
  });

  it('reads back what was written', async () => {
    await writeLlmSettings(configPath, { roles: { think: { model: 'm' } } });
    expect(await readLlmSettings(configPath)).toEqual({ roles: { think: { model: 'm' } } });
  });

  it('creates the file when it does not exist', async () => {
    await writeLlmSettings(configPath, { a: 1 });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ llm: { a: 1 } });
  });

  it('keeps the other keys when replacing llm', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        backend: { type: 'forge', url: 'http://127.0.0.1:7860' },
        llm: { old: true },
      }),
    );
    await writeLlmSettings(configPath, { next: true });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      backend: { type: 'forge', url: 'http://127.0.0.1:7860' },
      llm: { next: true },
    });
  });
});
