import { ManualGenerationRunner } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, FsJobStore } from '@drawroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { BackendBusyError, type BackendSettingsView } from '../backend-settings.js';
import { createApi } from '../index.js';
import { noCandidateNotes, noPermissionSettings, memoryBudgetSettings } from '../test-support.js';

function setup(initial: BackendSettingsView, { busy = false } = {}) {
  let view = initial;
  const written: { url: string }[] = [];
  const backend = new StubBackend();
  const store = new FsJobStore('/nonexistent-drawroid-test-root');
  const api = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore('/nonexistent-drawroid-test-root/memory'),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    backendSettings: {
      // 秘密を余分に載せて返す実装でも、API が漏らさないことを確かめるため、型を越えて返す
      read: async () => ({ ...view, auth: { username: 'u', password: 'secret' } }) as never,
      write: async (input) => {
        if (busy) throw new BackendBusyError('生成が走っている');
        written.push(input);
        view = { ...view, url: input.url, urlSource: 'config' };
        return view;
      },
    },
    // 繋ぎ直しの経路は自動ジョブと LLM の設定を使わない
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
      addMask: notUsed,
    },
    budgetSettings: memoryBudgetSettings(),
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
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
  kind: 'a1111',
  url: 'http://127.0.0.1:7860',
  urlSource: 'default',
  auth: null,
  generateTimeoutMs: null,
};

describe('GET /settings/backend', () => {
  it('returns the kind, the url, where it came from, and the auth username without the password', async () => {
    const { api } = setup(initial);
    const res = await api.request('/settings/backend');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'a1111',
      url: 'http://127.0.0.1:7860',
      urlSource: 'default',
      auth: { username: 'u' },
      generateTimeoutMs: null,
    });
  });
});

describe('PUT /settings/backend', () => {
  it('answers 409 with the reason while a generation runs', async () => {
    const { put, written } = setup(initial, { busy: true });
    const res = await put({ url: 'http://gpu:7860' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { kind: 'busy' } });
    expect(written).toEqual([]);
  });

  it('saves the url and returns the settings now in use', async () => {
    const { put, written } = setup(initial);
    const res = await put({ url: 'http://gpu:7860' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      url: 'http://gpu:7860',
      urlSource: 'config',
    });
    expect(written).toEqual([{ url: 'http://gpu:7860' }]);
  });

  it('does not return the password after saving either', async () => {
    const { put } = setup(initial);
    const res = await put({ url: 'https://gpu.example/' });
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it.each([
    ['not a url', { url: 'gpu:7860' }],
    ['a scheme other than http and https', { url: 'ftp://gpu:7860' }],
    ['a missing url', {}],
    ['the old name forgeUrl', { forgeUrl: 'http://gpu:7860' }],
    ['a url that is not a string', { url: 7860 }],
    ['a body that is not JSON', 'not json'],
  ])('refuses %s with invalid_request and saves nothing', async (_name, body) => {
    const { put, written } = setup(initial);
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    expect(written).toEqual([]);
  });

  it('ignores the kind, auth and generateTimeoutMs in the body', async () => {
    const { put, written } = setup(initial);
    await put({
      kind: 'forge',
      url: 'http://gpu:7860',
      auth: { username: 'x', password: 'y' },
      generateTimeoutMs: 1,
    });
    expect(written).toEqual([{ url: 'http://gpu:7860' }]);
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
