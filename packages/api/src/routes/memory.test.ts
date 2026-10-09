import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  generationRequestSchema,
  ManualGenerationRunner,
  type MemoryItem,
} from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { createFsMemoryStore, dataPaths, FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';

let root: string;
let memoryDir: string;
let jobs: FsJobStore;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-api-memory-'));
  memoryDir = dataPaths(root).memory;
  jobs = new FsJobStore(root);
  const backend = new StubBackend();
  api = createApi({
    backend,
    store: jobs,
    memoryStore: createFsMemoryStore(memoryDir),
    manualRunner: new ManualGenerationRunner({ backend, store: jobs }),
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    autoQueue: {
      kick: () => undefined,
      stop: async () => undefined,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
    },
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    env: {},
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const item: MemoryItem = {
  id: 'no-broken-fingers',
  body: '指の崩れは許容しない',
  tags: ['hands'],
  scope: 'always',
  sources: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

function itemFile(overrides: Partial<MemoryItem> = {}): string {
  const i = { ...item, ...overrides };
  return `---\ntags: [${i.tags.join(', ')}]\nscope: ${i.scope}\nsources: [${i.sources.join(', ')}]\ncreatedAt: ${i.createdAt}\nupdatedAt: ${i.updatedAt}\n---\n${i.body}\n`;
}

async function putFile(id: string, text: string) {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, `${id}.md`), text);
}

async function createJob(): Promise<string> {
  const spec = await jobs.createJob(
    { kind: 'auto', request: '猫の絵', stopConditions: { aiJudgement: true }, batchSize: 1 },
    { status: 'queued' },
    new Date('2026-10-01T00:00:00Z'),
  );
  return spec.jobId;
}

const edit = {
  body: '手の崩れは許容しない',
  tags: ['hands', 'anatomy'],
  scope: 'tagged',
  expectedUpdatedAt: item.updatedAt,
};

function put(id: string, body: unknown) {
  return api.request(`/memory/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /memory', () => {
  it('lists items and reports unreadable files with the reason without stopping the list', async () => {
    await putFile('no-broken-fingers', itemFile());
    await putFile('broken', 'front matter が無い');
    const res = await api.request('/memory');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      items: MemoryItem[];
      invalid: { id: string; reason: string }[];
    };
    expect(json.items.map((i) => i.id)).toEqual(['no-broken-fingers']);
    expect(json.invalid).toHaveLength(1);
    expect(json.invalid[0]).toMatchObject({ id: 'broken' });
    expect(json.invalid[0]?.reason).not.toBe('');
  });

  it('shows a file edited directly on the next read', async () => {
    await putFile('no-broken-fingers', itemFile());
    await api.request('/memory');
    await putFile('no-broken-fingers', itemFile({ body: '直接書き換えた' }));
    const list = (await (await api.request('/memory')).json()) as { items: MemoryItem[] };
    expect(list.items[0]?.body).toBe('直接書き換えた');
    const one = (await (await api.request('/memory/no-broken-fingers')).json()) as {
      item: MemoryItem;
    };
    expect(one.item.body).toBe('直接書き換えた');
  });
});

describe('GET /memory/:id', () => {
  it('returns the item with the jobs it was learned from, and null for a job that is gone', async () => {
    const jobId = await createJob();
    await putFile('no-broken-fingers', itemFile({ sources: [jobId, '20200101-000000-gone'] }));
    const res = await api.request('/memory/no-broken-fingers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      item: { ...item, sources: [jobId, '20200101-000000-gone'] },
      sources: [
        {
          jobId,
          job: { kind: 'auto', createdAt: '2026-10-01T00:00:00.000Z', request: '猫の絵' },
        },
        { jobId: '20200101-000000-gone', job: null },
      ],
    });
  });

  it('returns the prompt as the request of a manual job', async () => {
    const spec = await jobs.createJob(
      {
        kind: 'manual',
        request: generationRequestSchema.parse({
          prompt: 'a cat',
          steps: 4,
          cfgScale: 7,
          width: 64,
          height: 64,
        }),
      },
      { status: 'queued' },
      new Date('2026-10-01T00:00:00Z'),
    );
    await putFile('no-broken-fingers', itemFile({ sources: [spec.jobId] }));
    const json = (await (await api.request('/memory/no-broken-fingers')).json()) as {
      sources: { job: { kind: string; request: string } }[];
    };
    expect(json.sources[0]?.job).toMatchObject({ kind: 'manual', request: 'a cat' });
  });

  it('answers 404 for a missing item and 404 for a malformed id', async () => {
    expect((await api.request('/memory/nothing')).status).toBe(404);
    expect((await api.request('/memory/.hidden')).status).toBe(404);
    expect((await api.request('/memory/a%5Cb')).status).toBe(404);
  });

  it('answers 422 invalid_file for a file that cannot be read', async () => {
    await putFile('broken', 'front matter が無い');
    const res = await api.request('/memory/broken');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_file' } });
  });
});

describe('PUT /memory/:id', () => {
  it('changes only body, tags and scope, keeps the rest, and moves updatedAt', async () => {
    await putFile('no-broken-fingers', itemFile({ sources: ['j1'] }));
    const res = await put('no-broken-fingers', edit);
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { item: MemoryItem }).item;
    expect(saved).toMatchObject({
      id: 'no-broken-fingers',
      body: '手の崩れは許容しない',
      tags: ['hands', 'anatomy'],
      scope: 'tagged',
      sources: ['j1'],
      createdAt: item.createdAt,
    });
    expect(saved.updatedAt).not.toBe(item.updatedAt);
    const reread = (await (await api.request('/memory/no-broken-fingers')).json()) as {
      item: MemoryItem;
    };
    expect(reread.item).toEqual(saved);
  });

  it('ignores fields a human may not edit', async () => {
    await putFile('no-broken-fingers', itemFile());
    await put('no-broken-fingers', {
      ...edit,
      id: 'other',
      sources: ['x'],
      createdAt: '2000-01-01T00:00:00Z',
    });
    const json = (await (await api.request('/memory/no-broken-fingers')).json()) as {
      item: MemoryItem;
    };
    expect(json.item).toMatchObject({
      id: 'no-broken-fingers',
      sources: [],
      createdAt: item.createdAt,
    });
  });

  it('answers 409 conflict and leaves the file untouched when it changed after opening', async () => {
    await putFile('no-broken-fingers', itemFile({ updatedAt: '2026-10-03T00:00:00.000Z' }));
    const path = join(memoryDir, 'no-broken-fingers.md');
    const before = await readFile(path, 'utf8');
    const res = await put('no-broken-fingers', edit);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { kind: 'conflict' } });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('answers 404 for a missing item and a malformed id', async () => {
    expect((await put('nothing', edit)).status).toBe(404);
    expect((await put('.hidden', edit)).status).toBe(404);
  });

  it('answers 400 for an invalid body and does not write', async () => {
    await putFile('no-broken-fingers', itemFile());
    const path = join(memoryDir, 'no-broken-fingers.md');
    const before = await readFile(path, 'utf8');
    const bad = [
      '{not json',
      { ...edit, body: '   ' },
      { ...edit, body: 'あ'.repeat(81) },
      { ...edit, scope: 'sometimes' },
      { ...edit, tags: ['a', 'b', 'c', 'd', 'e'] },
      { ...edit, tags: [''] },
      { ...edit, expectedUpdatedAt: undefined },
    ];
    for (const body of bad) {
      const res = await put('no-broken-fingers', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { kind: 'invalid_request' } });
    }
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

describe('DELETE /memory/:id', () => {
  it('answers 204 and removes the item', async () => {
    await putFile('no-broken-fingers', itemFile());
    const res = await api.request('/memory/no-broken-fingers', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await api.request('/memory/no-broken-fingers')).status).toBe(404);
  });

  it('answers 404 for a missing item and a malformed id', async () => {
    expect((await api.request('/memory/nothing', { method: 'DELETE' })).status).toBe(404);
    expect((await api.request('/memory/.hidden', { method: 'DELETE' })).status).toBe(404);
  });
});

async function notUsed(): Promise<never> {
  throw new Error('この試験では使わない口');
}
