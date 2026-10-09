import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackendBusyError } from '@drawroid/api';
import { generationRequestSchema } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackendSettings, type BackendOptions } from './backend-settings.js';
import { readConfig } from './config.js';
import { ReplaceableBackend } from './replaceable-backend.js';

let dir: string;
let configPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-cli-settings-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// schema を通して作る: 要求に欄が足されても、既定値のある欄はここで埋まるため
const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

async function setup(config: object, source: 'cli' | 'config' | 'default' = 'config') {
  await writeFile(configPath, JSON.stringify(config));
  const first = new StubBackend({ generateDelayMs: 20 });
  const created: { options: BackendOptions; backend: StubBackend }[] = [];
  const backend = new ReplaceableBackend(first);
  const settings = createBackendSettings({
    configPath,
    backend,
    createBackend: (options) => {
      const next = new StubBackend();
      created.push({ options, backend: next });
      return next;
    },
    initial: {
      kind: 'a1111',
      url: 'http://old:7860',
      source,
      config: await readConfig(configPath),
    },
  });
  return { first, backend, settings, created };
}

describe('backend settings', () => {
  it('reports the kind and the url in use and where the url came from, without the password', async () => {
    const { settings } = await setup(
      { backend: { auth: { username: 'u', password: 'secret' }, generateTimeoutMs: 5000 } },
      'cli',
    );
    const view = await settings.read();
    expect(view).toEqual({
      kind: 'a1111',
      url: 'http://old:7860',
      urlSource: 'cli',
      auth: { username: 'u' },
      generateTimeoutMs: 5000,
    });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('sends generations to the new url after a write', async () => {
    const { settings, backend, first, created } = await setup({});
    const view = await settings.write({ url: 'http://new:7860' });
    await backend.generate(request, new AbortController().signal);
    expect(view).toMatchObject({
      kind: 'a1111',
      url: 'http://new:7860',
      urlSource: 'config',
    });
    expect(created[0]?.options.baseUrl).toBe('http://new:7860');
    expect(created[0]?.backend.requests).toHaveLength(1);
    expect(first.requests).toEqual([]);
    expect(await settings.read()).toEqual(view);
  });

  it('refuses to reconnect while a generation runs, leaving config.json and the url as they were', async () => {
    const { settings, backend, first } = await setup({ backend: { url: 'http://old:7860' } });
    const running = backend.generate(request, new AbortController().signal);
    await expect(settings.write({ url: 'http://new:7860' })).rejects.toBeInstanceOf(
      BackendBusyError,
    );
    await running;
    expect(first.requests).toHaveLength(1);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      backend: { url: 'http://old:7860' },
    });
    expect(await settings.read()).toMatchObject({ url: 'http://old:7860' });
    await settings.write({ url: 'http://new:7860' });
    expect(await settings.read()).toMatchObject({ url: 'http://new:7860' });
  });

  it('keeps the other keys, the kind, the auth and the timeout in config.json after a write', async () => {
    const backendConfig = {
      kind: 'a1111',
      url: 'http://old:7860',
      auth: { username: 'u', password: 'secret' },
      generateTimeoutMs: 5000,
    };
    const { settings, created } = await setup({ llm: { model: 'x' }, backend: backendConfig });
    await settings.write({ url: 'http://new:7860' });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      llm: { model: 'x' },
      backend: { ...backendConfig, url: 'http://new:7860' },
    });
    expect(created[0]?.options).toMatchObject({
      auth: { username: 'u', password: 'secret' },
      generateTimeoutMs: 5000,
    });
  });

  it('fails the write and keeps using the old url when config.json cannot be written', async () => {
    const first = new StubBackend();
    const backend = new ReplaceableBackend(first);
    const created: StubBackend[] = [];
    const unwritablePath = join(dir, 'no-such-dir', 'config.json');
    const settings = createBackendSettings({
      configPath: unwritablePath,
      backend,
      createBackend: () => {
        const next = new StubBackend();
        created.push(next);
        return next;
      },
      initial: { kind: 'a1111', url: 'http://old:7860', source: 'config', config: {} },
    });

    await expect(settings.write({ url: 'http://new:7860' })).rejects.toThrow();
    await backend.generate(request, new AbortController().signal);

    expect(first.requests).toHaveLength(1);
    expect(created.flatMap((b) => b.requests)).toEqual([]);
    expect(await settings.read()).toMatchObject({ url: 'http://old:7860' });
  });

  it('rewrites the old forgeUrl in config.json as url when it writes', async () => {
    const { settings } = await setup({ backend: { kind: 'a1111', forgeUrl: 'http://old:7860' } });
    await settings.write({ url: 'http://new:7860' });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      backend: { kind: 'a1111', url: 'http://new:7860' },
    });
  });

  it('creates config.json when it does not exist yet', async () => {
    const { settings } = await setup({});
    await rm(configPath);
    await settings.write({ url: 'http://new:7860' });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      backend: { url: 'http://new:7860' },
    });
  });
});
