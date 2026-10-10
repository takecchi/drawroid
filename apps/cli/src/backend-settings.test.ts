import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackendBusyError, type BackendKind } from '@drawroid/api';
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

/**
 * 試験の側から release するまで終わらない生成。走っている間を、時間に頼らずに作るため
 * （時間で作ると、config.json を読んでいる間に生成が終わり、断られずに繋ぎ直してしまうことがあった）
 */
class HeldStubBackend extends StubBackend {
  private open: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));

  release(): void {
    this.open();
  }

  override async generate(...args: Parameters<StubBackend['generate']>) {
    await this.gate;
    return super.generate(...args);
  }
}

type Source = 'cli' | 'config' | 'default';

async function setup(
  config: object,
  { source = 'config', kindSource = 'config' }: { source?: Source; kindSource?: Source } = {},
) {
  await writeFile(configPath, JSON.stringify(config));
  const first = new HeldStubBackend();
  const created: { kind: BackendKind; options: BackendOptions; backend: StubBackend }[] = [];
  const backend = new ReplaceableBackend(first);
  const settings = createBackendSettings({
    configPath,
    backend,
    createBackend: (kind, options) => {
      const next = new StubBackend();
      created.push({ kind, options, backend: next });
      return next;
    },
    initial: {
      kind: 'a1111',
      kindSource,
      url: 'http://old:7860',
      source,
      config: await readConfig(configPath),
    },
  });
  return { first, backend, settings, created };
}

describe('backend settings', () => {
  it('reports the kind and the url in use and where each came from, without the password', async () => {
    const { settings } = await setup(
      { backend: { auth: { username: 'u', password: 'secret' }, generateTimeoutMs: 5000 } },
      { source: 'cli', kindSource: 'cli' },
    );
    const view = await settings.read();
    expect(view).toEqual({
      kind: 'a1111',
      kindSource: 'cli',
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

  describe('changing the kind', () => {
    it('builds the new backend with the new kind, writes it to config.json, and reads it back with source config', async () => {
      const { settings, backend, first, created } = await setup(
        { backend: { kind: 'a1111', url: 'http://old:7860' } },
        { source: 'cli', kindSource: 'cli' },
      );
      const view = await settings.write({ url: 'http://new:7860', kind: 'forge' });
      await backend.generate(request, new AbortController().signal);

      expect(created.map(({ kind }) => kind)).toEqual(['forge']);
      expect(created[0]?.backend.requests).toHaveLength(1);
      expect(first.requests).toEqual([]);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        backend: { kind: 'forge', url: 'http://new:7860' },
      });
      expect(view).toMatchObject({ kind: 'forge', kindSource: 'config', urlSource: 'config' });
      expect(await settings.read()).toEqual(view);
    });

    it('keeps the auth and the timeout in config.json and hands them to the new backend', async () => {
      const { settings, created } = await setup({
        llm: { model: 'x' },
        backend: {
          kind: 'a1111',
          url: 'http://old:7860',
          auth: { username: 'u', password: 'secret' },
          generateTimeoutMs: 5000,
        },
      });
      await settings.write({ url: 'http://old:7860', kind: 'forge' });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        llm: { model: 'x' },
        backend: {
          kind: 'forge',
          url: 'http://old:7860',
          auth: { username: 'u', password: 'secret' },
          generateTimeoutMs: 5000,
        },
      });
      expect(created[0]?.options).toMatchObject({
        auth: { username: 'u', password: 'secret' },
        generateTimeoutMs: 5000,
      });
    });

    it('keeps the kind in use when the write leaves it out, and does not write a kind to config.json', async () => {
      const { settings, created } = await setup({});
      const view = await settings.write({ url: 'http://new:7860' });
      expect(created.map(({ kind }) => kind)).toEqual(['a1111']);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        backend: { url: 'http://new:7860' },
      });
      expect(view.kind).toBe('a1111');
    });

    // --backend で起動していると、人が触っていない種類が config.json に残り、次の起動の種類が変わってしまう
    it('leaves the kind already in config.json as it is, and the source as cli, when only the URL is saved', async () => {
      const { settings, created } = await setup(
        { backend: { kind: 'forge', url: 'http://old:7860' } },
        { kindSource: 'cli' },
      );
      const view = await settings.write({ url: 'http://new:7860' });
      expect(created.map(({ kind }) => kind)).toEqual(['a1111']);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        backend: { kind: 'forge', url: 'http://new:7860' },
      });
      expect(view).toMatchObject({ kind: 'a1111', kindSource: 'cli' });
      expect(await settings.read()).toEqual(view);
    });

    it('refuses while a generation runs, changing neither config.json nor the kind', async () => {
      const original = { backend: { kind: 'a1111', url: 'http://old:7860' } };
      const { settings, backend, first, created } = await setup(original);
      const running = backend.generate(request, new AbortController().signal);
      await expect(
        settings.write({ url: 'http://old:7860', kind: 'forge' }),
      ).rejects.toBeInstanceOf(BackendBusyError);
      first.release();
      await running;
      expect(first.requests).toHaveLength(1);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(original);
      expect(await settings.read()).toMatchObject({ kind: 'a1111', kindSource: 'config' });
      expect(created.flatMap(({ backend: b }) => b.requests)).toEqual([]);
    });

    it('keeps the old kind and its backend when config.json cannot be written', async () => {
      const first = new StubBackend();
      const backend = new ReplaceableBackend(first);
      const created: StubBackend[] = [];
      const settings = createBackendSettings({
        configPath: join(dir, 'no-such-dir', 'config.json'),
        backend,
        createBackend: () => {
          const next = new StubBackend();
          created.push(next);
          return next;
        },
        initial: {
          kind: 'a1111',
          kindSource: 'cli',
          url: 'http://old:7860',
          source: 'config',
          config: {},
        },
      });

      await expect(settings.write({ url: 'http://new:7860', kind: 'forge' })).rejects.toThrow();
      await backend.generate(request, new AbortController().signal);

      expect(first.requests).toHaveLength(1);
      expect(created.flatMap((b) => b.requests)).toEqual([]);
      expect(await settings.read()).toMatchObject({ kind: 'a1111', kindSource: 'cli' });
    });

    it('shows the new kind as in use when the old backend cannot be put back after a failed write', async () => {
      // 書いているあいだに新しい側で生成が始まった場合を、書き込みの失敗と同時に作る
      const backend = new ReplaceableBackend(new StubBackend());
      const held = new HeldStubBackend();
      let running: Promise<unknown> | undefined;
      const settings = createBackendSettings({
        configPath: join(dir, 'no-such-dir', 'config.json'),
        backend,
        createBackend: () => {
          // 差し替えた直後（書き込みの失敗が返る前）に、新しい側で生成を始める
          queueMicrotask(() => {
            running = backend.generate(request, new AbortController().signal);
          });
          return held;
        },
        initial: {
          kind: 'a1111',
          kindSource: 'cli',
          url: 'http://old:7860',
          source: 'config',
          config: {},
        },
      });
      await expect(settings.write({ url: 'http://new:7860', kind: 'forge' })).rejects.toThrow();
      expect(running).toBeDefined();
      expect(await settings.read()).toMatchObject({
        kind: 'forge',
        url: 'http://new:7860',
        kindSource: 'cli',
      });
      held.release();
      await running;
    });
  });

  it('refuses to reconnect while a generation runs, leaving config.json and the url as they were', async () => {
    const { settings, backend, first } = await setup({ backend: { url: 'http://old:7860' } });
    const running = backend.generate(request, new AbortController().signal);
    await expect(settings.write({ url: 'http://new:7860' })).rejects.toBeInstanceOf(
      BackendBusyError,
    );
    first.release();
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
      initial: {
        kind: 'a1111',
        kindSource: 'config',
        url: 'http://old:7860',
        source: 'config',
        config: {},
      },
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
