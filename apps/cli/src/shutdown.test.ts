import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { generationRequestSchema } from '@drawroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendFactory } from './backend-factory.js';
import { backendOptions } from './backend-settings.js';
import { ReplaceableBackend } from './replaceable-backend.js';
import { shutdownHandler } from './shutdown.js';

const request = generationRequestSchema.parse({
  prompt: 'a cat',
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          // 答えずに持っている要求（txt2img・答えない interrupt）も切る: 切らないと close が返らないため
          server.closeAllConnections();
        }),
    ),
  );
});

/**
 * 偽の Forge。txt2img は答えずに持っておき（生成が走っている間）、interrupt を受けたらそれを閉じる。
 * answerInterrupt が偽なら、interrupt にも答えない
 */
async function startForge({ answerInterrupt = true } = {}) {
  const received: string[] = [];
  const generating: ServerResponse[] = [];
  let generationStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (generationStarted = resolve));
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.url === '/sdapi/v1/txt2img') {
      generating.push(res);
      generationStarted();
      return;
    }
    if (req.url === '/sdapi/v1/interrupt') {
      if (!answerInterrupt) return;
      for (const held of generating.splice(0)) held.destroy();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Not Found' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, started };
}

function forgeBehind(url: string) {
  return new ReplaceableBackend(backendFactory('forge')(backendOptions(url, undefined)));
}

describe('shutdownHandler', () => {
  it('tells Forge to stop the generation it is running, then exits', async () => {
    const forge = await startForge();
    const backend = forgeBehind(forge.url);
    const generation = backend.generate(request, new AbortController().signal).catch(() => 'ended');
    await forge.started;
    const exit = vi.fn();

    await shutdownHandler({ backend, exit, log: () => undefined })('SIGINT');

    expect(forge.received).toContain('POST /sdapi/v1/interrupt');
    expect(exit).toHaveBeenCalledWith(130);
    expect(await generation).toBe('ended');
  });

  it('exits with the code of SIGTERM when it is told to end that way', async () => {
    const forge = await startForge();
    const backend = forgeBehind(forge.url);
    void backend.generate(request, new AbortController().signal).catch(() => undefined);
    await forge.started;
    const exit = vi.fn();

    await shutdownHandler({ backend, exit, log: () => undefined })('SIGTERM');

    expect(forge.received).toContain('POST /sdapi/v1/interrupt');
    expect(exit).toHaveBeenCalledWith(143);
  });

  // 止めさせない: drawroid が何も描いていないときの Forge は、人が Forge の画面で描いている途中かもしれないため
  it('does not tell Forge to stop when drawroid is not generating', async () => {
    const forge = await startForge();
    const backend = forgeBehind(forge.url);
    const exit = vi.fn();

    await shutdownHandler({ backend, exit, log: () => undefined })('SIGINT');

    expect(forge.received).not.toContain('POST /sdapi/v1/interrupt');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('still exits when Forge does not answer the interrupt', async () => {
    const forge = await startForge({ answerInterrupt: false });
    const backend = forgeBehind(forge.url);
    void backend.generate(request, new AbortController().signal).catch(() => undefined);
    await forge.started;
    const exit = vi.fn();

    await shutdownHandler({ backend, exit, log: () => undefined, timeoutMs: 100 })('SIGINT');

    expect(forge.received).toContain('POST /sdapi/v1/interrupt');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('exits at once on a second signal while it waits for Forge', async () => {
    const forge = await startForge({ answerInterrupt: false });
    const backend = forgeBehind(forge.url);
    void backend.generate(request, new AbortController().signal).catch(() => undefined);
    await forge.started;
    const exit = vi.fn();
    const handle = shutdownHandler({ backend, exit, log: () => undefined, timeoutMs: 60_000 });

    void handle('SIGINT');
    await vi.waitFor(() => expect(forge.received).toContain('POST /sdapi/v1/interrupt'));
    await handle('SIGINT');

    expect(exit).toHaveBeenCalledWith(130);
  });
});
