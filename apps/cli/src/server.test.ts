import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
