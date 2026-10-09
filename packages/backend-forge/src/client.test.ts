import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ForgeClient } from './client.js';
import { json, startMockForge, unusedUrl, type MockForge } from './test-support/mock-forge.js';

const anything = z.unknown();
let forge: MockForge;

beforeEach(async () => {
  forge = await startMockForge();
});

afterEach(async () => {
  await forge.close();
});

function clientFor(baseUrl: string, timeoutMs = 5_000) {
  return new ForgeClient({ baseUrl, timeoutMs });
}

describe('ForgeClient errors', () => {
  it('says Forge is unreachable when nothing listens on the URL', async () => {
    const url = await unusedUrl();
    await expect(clientFor(url).getJson('/sdapi/v1/cmd-flags', anything)).rejects.toMatchObject({
      name: 'BackendError',
      kind: 'unreachable',
      message: expect.stringContaining(url) as unknown,
    });
  });

  it('names the URL and the underlying reason when fetch fails without a known code', async () => {
    // fetch はポート 1 を危険なポートとして、繋ぎに行かずに断る
    const url = 'http://127.0.0.1:1';
    await expect(clientFor(url).getJson('/sdapi/v1/cmd-flags', anything)).rejects.toMatchObject({
      kind: 'unreachable',
      message: expect.stringMatching(/127\.0\.0\.1:1.*bad port/) as unknown,
    });
  });

  it('says the API is missing when the path is not found (wrong URL or no --api)', async () => {
    await expect(
      clientFor(`${forge.url}/wrong`).getJson('/sdapi/v1/cmd-flags', anything),
    ).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('--api') as unknown,
    });
  });

  it('says authentication failed on 401', async () => {
    forge.route('GET /sdapi/v1/cmd-flags', json(401, { detail: 'Incorrect username or password' }));
    await expect(
      clientFor(forge.url).getJson('/sdapi/v1/cmd-flags', anything),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('says authentication failed on 403 as well', async () => {
    forge.route('GET /sdapi/v1/cmd-flags', json(403, { detail: 'Forbidden' }));
    await expect(
      clientFor(forge.url).getJson('/sdapi/v1/cmd-flags', anything),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('cuts a very long reason from Forge down to 500 characters', async () => {
    forge.route('POST /sdapi/v1/txt2img', json(500, { detail: 'Z'.repeat(2000) }));
    const error: unknown = await clientFor(forge.url)
      .postJson('/sdapi/v1/txt2img', {}, anything)
      .catch((e: unknown) => e);
    const reasonLength = /Z+/.exec((error as Error).message)?.[0].length ?? 0;
    expect(reasonLength).toBeGreaterThan(400);
    expect(reasonLength).toBeLessThanOrEqual(500);
  });

  it('passes on the reason Forge gives when it fails', async () => {
    forge.route(
      'POST /sdapi/v1/txt2img',
      json(500, { error: 'OutOfMemoryError', errors: 'CUDA out of memory' }),
    );
    await expect(
      clientFor(forge.url).postJson('/sdapi/v1/txt2img', {}, anything),
    ).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('CUDA out of memory') as unknown,
    });
  });

  it('reports a body that is not JSON as a bad response', async () => {
    forge.route('GET /sdapi/v1/cmd-flags', (_req, res) => res.end('<html>'));
    await expect(
      clientFor(forge.url).getJson('/sdapi/v1/cmd-flags', anything),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('times out when Forge does not answer in time', async () => {
    forge.route('GET /sdapi/v1/cmd-flags', () => undefined);
    await expect(
      clientFor(forge.url, 100).getJson('/sdapi/v1/cmd-flags', anything),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports a caller abort as aborted, not as a timeout', async () => {
    forge.route('GET /sdapi/v1/cmd-flags', () => undefined);
    const controller = new AbortController();
    const pending = clientFor(forge.url).getJson('/sdapi/v1/cmd-flags', anything, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('ForgeClient requests', () => {
  it('keeps a path prefix in the base URL', async () => {
    forge.route('GET /forge/sdapi/v1/cmd-flags', json(200, { ok: true }));
    expect(await clientFor(`${forge.url}/forge`).getJson('/sdapi/v1/cmd-flags', anything)).toEqual({
      ok: true,
    });
  });

  it('sends basic auth only when configured', async () => {
    const withAuth = new ForgeClient({
      baseUrl: forge.url,
      timeoutMs: 5_000,
      auth: { username: 'u', password: 'p' },
    });
    await withAuth.getJson('/sdapi/v1/cmd-flags', anything);
    await clientFor(forge.url).getJson('/sdapi/v1/cmd-flags', anything);
    expect(forge.requests.map((r) => r.headers.authorization)).toEqual([
      `Basic ${btoa('u:p')}`,
      undefined,
    ]);
  });

  it('does not put the password in error messages', async () => {
    forge.route('GET /sdapi/v1/cmd-flags', json(500, { detail: 'boom' }));
    const withAuth = new ForgeClient({
      baseUrl: forge.url,
      timeoutMs: 5_000,
      auth: { username: 'u', password: 'secret-pass' },
    });
    const error: unknown = await withAuth
      .getJson('/sdapi/v1/cmd-flags', anything)
      .catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('secret-pass');
  });

  it('rejects a base URL that is not http or https', () => {
    expect(() => clientFor('ftp://example.com')).toThrow(/http/);
    expect(() => clientFor('not a url')).toThrow();
  });
});
