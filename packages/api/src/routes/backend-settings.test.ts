import { DEFAULT_BUDGET, ManualGenerationRunner } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { BackendBusyError, type BackendSettingsView } from '../backend-settings.js';
import { createApi } from '../index.js';

function setup(initial: BackendSettingsView, { busy = false } = {}) {
  let view = initial;
  const written: { forgeUrl: string }[] = [];
  const backend = new StubBackend();
  const store = new FsJobStore('/nonexistent-drawroid-test-root');
  const api = createApi({
    backend,
    store,
    manualRunner: new ManualGenerationRunner({ backend, store }),
    backendSettings: {
      // 秘密を余分に載せて返す実装でも、API が漏らさないことを確かめるため、型を越えて返す
      read: async () => ({ ...view, auth: { username: 'u', password: 'secret' } }) as never,
      write: async (input) => {
        if (busy) throw new BackendBusyError('生成が走っている');
        written.push(input);
        view = { ...view, forgeUrl: input.forgeUrl, forgeUrlSource: 'config' };
        return view;
      },
    },
    autoQueue: { kick: () => undefined, stop: async () => undefined },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
  });
  const put = (body: unknown) =>
    api.request('/settings/backend', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { api, put, written };
}

const initial: BackendSettingsView = {
  forgeUrl: 'http://127.0.0.1:7860',
  forgeUrlSource: 'default',
  auth: null,
  generateTimeoutMs: null,
};

describe('GET /settings/backend', () => {
  it('returns the url, where it came from, and the auth username without the password', async () => {
    const { api } = setup(initial);
    const res = await api.request('/settings/backend');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      forgeUrl: 'http://127.0.0.1:7860',
      forgeUrlSource: 'default',
      auth: { username: 'u' },
      generateTimeoutMs: null,
    });
  });
});

describe('PUT /settings/backend', () => {
  it('answers 409 with the reason while a generation runs', async () => {
    const { put, written } = setup(initial, { busy: true });
    const res = await put({ forgeUrl: 'http://gpu:7860' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { kind: 'busy' } });
    expect(written).toEqual([]);
  });

  it('saves the url and returns the settings now in use', async () => {
    const { put, written } = setup(initial);
    const res = await put({ forgeUrl: 'http://gpu:7860' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      forgeUrl: 'http://gpu:7860',
      forgeUrlSource: 'config',
    });
    expect(written).toEqual([{ forgeUrl: 'http://gpu:7860' }]);
  });

  it('does not return the password after saving either', async () => {
    const { put } = setup(initial);
    const res = await put({ forgeUrl: 'https://gpu.example/' });
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it.each([
    ['not a url', { forgeUrl: 'gpu:7860' }],
    ['a scheme other than http and https', { forgeUrl: 'ftp://gpu:7860' }],
    ['a missing url', {}],
    ['a url that is not a string', { forgeUrl: 7860 }],
    ['a body that is not JSON', 'not json'],
  ])('refuses %s with invalid_request and saves nothing', async (_name, body) => {
    const { put, written } = setup(initial);
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    expect(written).toEqual([]);
  });

  it('ignores auth and generateTimeoutMs in the body', async () => {
    const { put, written } = setup(initial);
    await put({
      forgeUrl: 'http://gpu:7860',
      auth: { username: 'x', password: 'y' },
      generateTimeoutMs: 1,
    });
    expect(written).toEqual([{ forgeUrl: 'http://gpu:7860' }]);
  });
});
