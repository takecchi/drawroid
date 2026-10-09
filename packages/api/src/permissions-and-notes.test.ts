// 全体の既定の許可と候補の説明を HTTP API で読み書きし、書いた許可が走行中のジョブの次の回から効くことを見る試験（Issue #48）。
// 置き場所は本物のファイル、LLM は台本どおりに返すスタブ、バックエンドは M1 のスタブ
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  ManualGenerationRunner,
  mergePermissions,
  permissionOverridesSchema,
  type Permissions,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import {
  createFsMemoryStore,
  dataPaths,
  FsJobStore,
  readCandidateNotes,
  readPermissionSettings,
  writeCandidateNotes,
  writePermissionSettings,
} from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from './index.js';

const base: Permissions = basicPermissions({ width: 64, height: 64 });

let root: string;
let paths: ReturnType<typeof dataPaths>;
let store: FsJobStore;
let backend: StubBackend;
let runner: JobRunner;
let app: ReturnType<typeof createApi>;
let onJudge: (n: number) => Promise<void>;

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 1, steps: 50, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = async (call, n) => {
  await onJudge(n);
  return {
    images: call.messages.user
      .filter((part) => part.type === 'image')
      .map(() => ({ score: 0.5, issues: [] })),
    nextChange: 'そのまま',
    canStop: false,
  };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-permissions-api-'));
  paths = dataPaths(root);
  store = new FsJobStore(root);
  backend = new StubBackend();
  onJudge = async () => undefined;
  runner = new JobRunner({
    store,
    llm: new ScriptedLlm({ think, judge }),
    backend,
    budget: DEFAULT_BUDGET,
    // 回ごとに config.json を読み直す（CLI と同じ組み立て）
    permissions: async () =>
      mergePermissions(
        base,
        permissionOverridesSchema.parse((await readPermissionSettings(paths.config)) ?? {}),
      ),
  });
  app = createApi({
    backend,
    store,
    memoryStore: createFsMemoryStore(paths.memory),
    manualRunner: new ManualGenerationRunner({ backend, store }),
    autoQueue: runner,
    budget: DEFAULT_BUDGET,
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    permissionSettings: {
      base,
      read: () => readPermissionSettings(paths.config),
      write: (overrides) => writePermissionSettings(paths.config, overrides),
    },
    candidateNotes: {
      read: () => readCandidateNotes(paths.candidateNotes),
      write: (notes) => writeCandidateNotes(paths.candidateNotes, notes),
    },
    env: {},
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const send = (method: 'PUT' | 'POST', path: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const readConfig = async () =>
  JSON.parse(await readFile(paths.config, 'utf8')) as Record<string, unknown>;

describe('the default permissions over HTTP', () => {
  it('answers the base permissions when none are set', async () => {
    const res = await app.request('/settings/permissions');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overrides: {}, permissions: base });
  });

  it('writes only the permissions key of config.json and answers with the permissions now in effect', async () => {
    await writeFile(
      paths.config,
      JSON.stringify({ llm: { providers: {} }, backend: { forgeUrl: 'http://127.0.0.1:7860' } }),
    );

    const res = await send('PUT', '/settings/permissions', {
      steps: { mode: 'fixed', value: 28 },
      checkpoint: { mode: 'auto', choices: ['animeMix'] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: Permissions };
    expect(body.permissions.steps).toEqual({ mode: 'fixed', value: 28 });
    expect(body.permissions.prompt).toEqual({ mode: 'auto' });
    expect(await readConfig()).toEqual({
      llm: { providers: {} },
      backend: { forgeUrl: 'http://127.0.0.1:7860' },
      permissions: {
        steps: { mode: 'fixed', value: 28 },
        checkpoint: { mode: 'auto', choices: ['animeMix'] },
      },
    });
  });

  it('refuses permissions it cannot take, leaving config.json as it was', async () => {
    await writeFile(paths.config, JSON.stringify({ llm: { providers: {} } }));

    for (const body of [
      // 必須の欄は「使わない」にできない（Issue #5 の K）
      { prompt: { mode: 'off' } },
      { notAParameter: { mode: 'auto' } },
      { steps: { mode: 'sometimes' } },
    ]) {
      expect((await send('PUT', '/settings/permissions', body)).status).toBe(400);
    }
    expect(await readConfig()).toEqual({ llm: { providers: {} } });
  });

  it('refuses a fixed value of the wrong shape, saying which field it was, and writes nothing', async () => {
    await writeFile(paths.config, JSON.stringify({ llm: { providers: {} } }));

    const res = await send('PUT', '/settings/permissions', {
      cfgScale: { mode: 'auto' },
      steps: { mode: 'fixed', value: 'twenty' },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('invalid_request');
    expect(body.error.message).toContain('steps.value');
    expect(await readConfig()).toEqual({ llm: { providers: {} } });
  });

  it('says the stored permissions are broken instead of answering something else', async () => {
    await writeFile(paths.config, JSON.stringify({ permissions: { prompt: { mode: 'off' } } }));

    const res = await app.request('/settings/permissions');

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_config' } });
  });
});

describe('a running job takes the default permissions written over HTTP', () => {
  it('uses the new permissions from its next iteration', async () => {
    onJudge = async (n) => {
      if (n === 0) {
        expect(
          (await send('PUT', '/settings/permissions', { steps: { mode: 'fixed', value: 28 } }))
            .status,
        ).toBe(200);
      }
    };
    const res = await send('POST', '/jobs/auto', {
      request: '夕暮れの海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations: 2 },
    });
    expect(res.status).toBe(202);
    await runner.idle();

    expect(backend.requests.map((r) => r.steps)).toEqual([50, 28]);
  });

  it('keeps the permissions the job overrode, whatever the defaults become', async () => {
    onJudge = async (n) => {
      if (n === 0) {
        await send('PUT', '/settings/permissions', {
          steps: { mode: 'fixed', value: 28 },
          cfgScale: { mode: 'fixed', value: 9 },
        });
      }
    };
    await send('POST', '/jobs/auto', {
      request: '夕暮れの海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations: 2 },
      permissions: { cfgScale: { mode: 'fixed', value: 5 } },
    });
    await runner.idle();

    expect(backend.requests.map((r) => r.cfgScale)).toEqual([5, 5]);
    expect(backend.requests.map((r) => r.steps)).toEqual([50, 28]);
  });
});

describe('the notes on candidates over HTTP', () => {
  it('answers no notes when none are written', async () => {
    const res = await app.request('/backend/candidate-notes');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: {} });
  });

  it('writes the notes to candidate-notes.json and reads them back', async () => {
    const res = await send('PUT', '/backend/candidate-notes', {
      watercolor_v2: '水彩の滲み。重みは 0.6 まで',
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(await readFile(paths.candidateNotes, 'utf8'))).toEqual({
      watercolor_v2: '水彩の滲み。重みは 0.6 まで',
    });
    expect(await (await app.request('/backend/candidate-notes')).json()).toEqual({
      notes: { watercolor_v2: '水彩の滲み。重みは 0.6 まで' },
    });
  });

  it('answers why when the file a human edited cannot be read', async () => {
    await writeFile(paths.candidateNotes, '{ "watercolor_v2": ');

    const body = (await (await app.request('/backend/candidate-notes')).json()) as {
      notes: object;
      problem?: string;
    };

    expect(body.notes).toEqual({});
    expect(body.problem).toContain('candidate-notes.json');
  });

  it('refuses notes it cannot take, writing nothing', async () => {
    for (const body of [{ watercolor_v2: '' }, { watercolor_v2: 3 }, ['水彩']]) {
      expect((await send('PUT', '/backend/candidate-notes', body)).status).toBe(400);
    }
    await expect(readFile(paths.candidateNotes, 'utf8')).rejects.toThrow();
  });
});
