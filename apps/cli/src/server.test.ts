import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { stubDeps } from './test-support.js';

import { createApp } from './server.js';

const webRoot = fileURLToPath(new URL('./test-fixtures/web', import.meta.url));
const app = createApp({ webRoot, deps: stubDeps() });

describe('createApp', () => {
  it('serves the API under /api', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers unknown API paths with a JSON 404 instead of the Web UI', async () => {
    const res = await app.request('/api/no-such-route');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('serves the Web UI at the root', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture index');
  });

  it('serves built assets as files', async () => {
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture = true');
  });

  it('falls back to the Web UI for client-side routes', async () => {
    const res = await app.request('/jobs/20261009-153012-k3f9');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture index');
  });
});

describe('createApp, when the Web UI has not been built', () => {
  async function withoutWebBuild(run: (app: ReturnType<typeof createApp>) => Promise<void>) {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'drawroid-no-web-'));
    try {
      await run(createApp({ webRoot: emptyRoot, deps: stubDeps() }));
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  }

  it.each(['/', '/settings'])(
    'tells what to open or build instead of an internal error at %s',
    async (path) => {
      await withoutWebBuild(async (app) => {
        const res = await app.request(path);
        expect(res.status).toBe(503);
        expect(res.headers.get('content-type')).toContain('text/html');
        const body = await res.text();
        expect(body).toContain('http://localhost:5173/');
        expect(body).toContain('pnpm build');
      });
    },
  );

  it('still serves the API', async () => {
    await withoutWebBuild(async (app) => {
      expect((await app.request('/api/health')).status).toBe(200);
      const unknown = await app.request('/api/no-such-route');
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: 'not_found' });
    });
  });

  // 起動の知らせは assemble が日本語で出す。serveStatic の英語の警告（root path … is not found）は出さない
  it('does not print an English warning about the missing web build', async () => {
    const work = await mkdtemp(join(tmpdir(), 'drawroid-no-web-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp({ webRoot: join(work, 'build', 'client'), deps: stubDeps() });
      await app.request('/');
      await app.request('/assets/app.js');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('serves a web build made after it started, without a restart', async () => {
    const work = await mkdtemp(join(tmpdir(), 'drawroid-no-web-'));
    const lateRoot = join(work, 'build', 'client');
    try {
      const app = createApp({ webRoot: lateRoot, deps: stubDeps() });
      expect((await app.request('/assets/app.js')).status).not.toBe(200);

      await mkdir(join(lateRoot, 'assets'), { recursive: true });
      await writeFile(join(lateRoot, 'index.html'), '<p>late index</p>');
      await writeFile(join(lateRoot, 'assets', 'app.js'), 'late = true');

      const asset = await app.request('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain('late = true');
      expect(await (await app.request('/')).text()).toContain('late index');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('createApp, asked under a name other than this machine', () => {
  // DNS rebinding: 別のサイトの名前を 127.0.0.1 へ向け直すと、ブラウザはそのサイトの名前（Host）のまま、ここへ要求を送る
  it.each([
    'http://attacker.example:7878/api/settings/llm',
    'http://attacker.example/api/health',
    'http://127.0.0.1.attacker.example:7878/api/health',
    'http://attacker.example:7878/',
  ])('refuses %s', async (url) => {
    const res = await app.request(url);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { kind: 'forbidden_host' } });
  });

  it('refuses a request that would change something, too', async () => {
    const res = await app.request('http://attacker.example:7878/api/conversations', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  // 開発中は Vite（localhost:5173）が Host を変えずに中継する。ポートは問わない
  it.each([
    'http://127.0.0.1:7878/api/health',
    'http://localhost:7878/api/health',
    'http://localhost:5173/api/health',
    'http://[::1]:7878/api/health',
    'http://LOCALHOST:7878/api/health',
  ])('serves %s', async (url) => {
    const res = await app.request(url);
    expect(res.status).toBe(200);
  });
});

describe('createApp, sent a change from a page of another site', () => {
  // 別のサイトのページは、プリフライトの要らない「単純な要求」（text/plain の POST）なら、ここへ送れてしまう。
  // ブラウザは、そのページのオリジンを Origin に付ける
  const fromAttacker = { Origin: 'https://attacker.example' };

  it('refuses to create a conversation', async () => {
    const res = await app.request('/api/conversations', { method: 'POST', headers: fromAttacker });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { kind: 'forbidden_origin' } });
  });

  // 手動の生成の口は、content-type を見ずに本文を JSON として読む。text/plain でも生成が始まってしまう
  it('refuses a text/plain body that the route reads as JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drawroid-server-'));
    try {
      const res = await createApp({ webRoot, deps: stubDeps(root) }).request('/api/jobs/manual', {
        method: 'POST',
        headers: { ...fromAttacker, 'content-type': 'text/plain' },
        body: JSON.stringify({ prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64 }),
      });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['null', 'http://127.0.0.1.attacker.example:7878'])(
    'refuses the origin %s',
    async (origin) => {
      const res = await app.request('/api/conversations', {
        method: 'POST',
        headers: { Origin: origin },
      });
      expect(res.status).toBe(403);
    },
  );

  // 読むだけの要求は、別のサイトのページからは中身が読めない（CORS を許していない）ので、断らない
  it('still answers a read from another site', async () => {
    const res = await app.request('/api/health', { headers: fromAttacker });
    expect(res.status).toBe(200);
  });

  it.each([
    ['this machine', { Origin: 'http://127.0.0.1:7878' }],
    ['the dev server', { Origin: 'http://localhost:5173' }],
    ['a tool without Origin (curl)', {}],
  ])('takes a change sent from %s', async (_, headers) => {
    const res = await app.request('/api/conversations', { method: 'POST', headers });
    expect(res.status).toBe(201);
  });
});
