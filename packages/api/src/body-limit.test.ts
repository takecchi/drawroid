import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type GenerationResult,
  type StopConditionsDraft,
} from '@drawroid/core';
import { ScriptedLlm, STUB_PNG, StubBackend } from '@drawroid/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createAutoJob, memoryConversations, request, setup } from './test-support.js';

const MIB = 1024 * 1024;
const PLAIN_LIMIT = 1 * MIB;
const IMAGE_LIMIT = 48 * MIB;

const PNG_BASE64 = Buffer.from(STUB_PNG).toString('base64');

const oneImage: GenerationResult = {
  images: [{ png: Uint8Array.of(137, 80, 78, 71, 0), seed: 0, metadata: {} }],
  metadata: {},
};

const draft: StopConditionsDraft = {
  ok: true,
  conditions: { aiJudgement: true, maxIterations: 10 },
  unparsed: [],
  warnings: [],
};

const backendView = {
  kind: 'a1111',
  url: 'http://gpu:7860',
  urlSource: 'config',
  auth: null,
  generateTimeoutMs: null,
} as const;

const MEMORY_ID = 'no-broken-fingers';
const MEMORY_UPDATED_AT = '2026-10-02T00:00:00.000Z';

function memoize<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}

async function fixtures() {
  const backend = new StubBackend();
  const conversations = memoryConversations();
  const addUpload = vi.spyOn(conversations.store, 'addUpload');
  // 実行器を先に作らない: 置き場所は setup が作るので、最初に呼ばれるまで待つ
  let made: JobRunner | undefined;
  const runner = () =>
    (made ??= new JobRunner({
      store: ctx.store,
      llm: new ScriptedLlm({}),
      backend,
      budget: DEFAULT_BUDGET,
      permissions: basicPermissions({ width: 64, height: 64 }),
    }));
  const ctx = await setup({
    backend,
    conversations,
    env: { TEST_KEY: 'not-a-real-key' },
    autoQueue: {
      kick: () => undefined,
      stop: (jobId) => runner().stop(jobId),
      addInstruction: (jobId, text) => runner().addInstruction(jobId, text),
      changeStopConditions: (jobId, change) => runner().changeStopConditions(jobId, change),
      addReference: (jobId, reference) => runner().addReference(jobId, reference),
      addMask: (jobId, mask) => runner().addMask(jobId, mask),
      adopt: (jobId, image) => runner().adopt(jobId, image),
    },
    backendSettings: { read: async () => backendView, write: async () => backendView },
    stopConditionParser: { parse: async () => draft },
  });

  const job = memoize(async () => {
    const spec = await createAutoJob(ctx.store);
    await ctx.store.writeGeneration(spec.jobId, 2, request, oneImage);
    return spec.jobId;
  });
  const conversation = memoize(
    async () => (await conversations.store.createConversation(new Date())).conversationId,
  );
  const memoryItem = memoize(async () => {
    await mkdir(ctx.paths.memory, { recursive: true });
    await writeFile(
      join(ctx.paths.memory, `${MEMORY_ID}.md`),
      `---\ntags: [hands]\nscope: always\nsources: []\ncreatedAt: 2026-10-01T00:00:00.000Z\nupdatedAt: ${MEMORY_UPDATED_AT}\n---\n指の崩れは許容しない\n`,
    );
    return MEMORY_ID;
  });

  return { ...ctx, addUpload, job, conversation, memoryItem };
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>;

type BodyRoute = {
  name: string;
  method: 'POST' | 'PUT' | 'PATCH';
  target: (f: Fixtures) => Promise<string>;
  body: unknown;
  ok: number;
};

type ImageBodyRoute = BodyRoute & {
  /** 受けた本文から保存されたものの数 */
  stored: (f: Fixtures) => Promise<number>;
};

const storedInterventions = async (f: Fixtures) => {
  const jobId = await f.job();
  return (
    (await f.store.listInterventions(jobId)).length + (await f.store.listReferences(jobId)).length
  );
};

const IMAGE_ROUTES: ImageBodyRoute[] = [
  {
    name: 'POST /jobs/auto',
    method: 'POST',
    target: async () => '/jobs/auto',
    body: {
      request: '猫の絵',
      references: [{ mediaType: 'image/png', data: PNG_BASE64 }],
    },
    ok: 202,
    stored: async (f) => (await f.store.listJobIds()).length,
  },
  {
    name: 'POST /jobs/auto/:jobId/interventions (reference)',
    method: 'POST',
    target: async (f) => `/jobs/auto/${await f.job()}/interventions`,
    body: { kind: 'reference', image: { mediaType: 'image/png', data: PNG_BASE64 } },
    ok: 202,
    stored: storedInterventions,
  },
  {
    name: 'POST /jobs/auto/:jobId/interventions (mask)',
    method: 'POST',
    target: async (f) => `/jobs/auto/${await f.job()}/interventions`,
    body: {
      kind: 'mask',
      image: { iteration: 2, index: 0 },
      mask: { data: PNG_BASE64 },
    },
    ok: 202,
    stored: storedInterventions,
  },
  {
    name: 'POST /conversations/:conversationId/uploads',
    method: 'POST',
    target: async (f) => `/conversations/${await f.conversation()}/uploads`,
    body: { mediaType: 'image/png', data: PNG_BASE64 },
    ok: 201,
    stored: async (f) => f.addUpload.mock.calls.length,
  },
];

const PLAIN_ROUTES: BodyRoute[] = [
  {
    name: 'POST /jobs/manual',
    method: 'POST',
    target: async () => '/jobs/manual',
    body: request,
    ok: 202,
  },
  {
    name: 'POST /jobs/:jobId/adopt',
    method: 'POST',
    target: async (f) => `/jobs/${await f.job()}/adopt`,
    body: { iteration: 2, index: 0 },
    ok: 200,
  },
  {
    name: 'PUT /jobs/:jobId/selections/:imageKey',
    method: 'PUT',
    target: async (f) => `/jobs/${await f.job()}/selections/2-0`,
    body: { verdict: 'favorite' },
    ok: 200,
  },
  {
    name: 'PUT /settings/backend',
    method: 'PUT',
    target: async () => '/settings/backend',
    body: { url: 'http://gpu:7860' },
    ok: 200,
  },
  {
    name: 'PUT /settings/budgets',
    method: 'PUT',
    target: async () => '/settings/budgets',
    body: {},
    ok: 200,
  },
  {
    name: 'PUT /backend/candidate-notes',
    method: 'PUT',
    target: async () => '/backend/candidate-notes',
    body: { 'lora-a': '説明' },
    ok: 200,
  },
  {
    name: 'PUT /settings/generation-progress',
    method: 'PUT',
    target: async () => '/settings/generation-progress',
    body: { includePreview: true },
    ok: 200,
  },
  {
    name: 'PUT /settings/llm',
    method: 'PUT',
    target: async () => '/settings/llm',
    body: {
      providers: { cloud: { type: 'anthropic', apiKeyEnv: 'TEST_KEY' } },
      roles: { think: { provider: 'cloud', model: 'claude-haiku-5-5' } },
    },
    ok: 200,
  },
  {
    name: 'PUT /settings/permissions',
    method: 'PUT',
    target: async () => '/settings/permissions',
    body: {},
    ok: 200,
  },
  {
    name: 'PUT /memory/:id',
    method: 'PUT',
    target: async (f) => `/memory/${await f.memoryItem()}`,
    body: {
      body: '手の崩れは許容しない',
      tags: ['hands'],
      scope: 'tagged',
      expectedUpdatedAt: MEMORY_UPDATED_AT,
    },
    ok: 200,
  },
  {
    name: 'POST /stop-conditions/parse',
    method: 'POST',
    target: async () => '/stop-conditions/parse',
    body: { text: '10回まで' },
    ok: 200,
  },
  {
    name: 'PATCH /conversations/:conversationId',
    method: 'PATCH',
    target: async (f) => `/conversations/${await f.conversation()}`,
    body: { title: '猫の絵' },
    ok: 200,
  },
  {
    name: 'POST /conversations/:conversationId/messages',
    method: 'POST',
    target: async (f) => `/conversations/${await f.conversation()}/messages`,
    body: { text: '猫を描いて' },
    ok: 202,
  },
  {
    name: 'POST /conversations/:conversationId/interrupt',
    method: 'POST',
    target: async (f) => `/conversations/${await f.conversation()}/interrupt`,
    body: { scope: 'turn' },
    ok: 202,
  },
];

/** 本文を読まない口。上限は全体にかかるので、ここに挙げて「本文を受ける口の一覧」から漏れていないことを確かめる */
const ROUTES_THAT_READ_NO_BODY = [
  'POST /jobs/manual/:jobId/stop',
  'POST /jobs/auto/:jobId/stop',
  'POST /conversations',
  'POST /doctor',
  'DELETE /memory/:id',
];

/** 正しい要求の JSON を、後ろの空白で bytes バイトちょうどにする */
function paddedJson(body: unknown, bytes: number): string {
  const json = JSON.stringify(body);
  const size = Buffer.byteLength(json);
  if (size > bytes) throw new Error(`本文が ${bytes} バイトに収まらない`);
  return json + ' '.repeat(bytes - size);
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function sendWithLength(f: Fixtures, route: BodyRoute, text: string) {
  return f.api.request(await route.target(f), {
    method: route.method,
    headers: { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(text)) },
    body: text,
  });
}

/** Content-Length を付けず、チャンクで送る。読まれたバイト数も返す */
async function sendChunked(f: Fixtures, route: BodyRoute, text: string) {
  const bytes = Buffer.from(text);
  const CHUNK = 64 * 1024;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + CHUNK));
      offset += CHUNK;
    },
  });
  const res = await f.api.request(await route.target(f), {
    method: route.method,
    headers: JSON_HEADERS,
    body,
    duplex: 'half',
  } as RequestInit);
  return { res, pulled: () => Math.min(offset, bytes.length) };
}

async function expectPayloadTooLarge(res: Response, limitLabel: string) {
  expect(res.status).toBe(413);
  const body = (await res.json()) as { error: { kind: string; message: string } };
  expect(body.error.kind).toBe('payload_too_large');
  expect(body.error.message).toContain(limitLabel);
}

describe('the size limit of a request body: routes that carry images', () => {
  it.each(IMAGE_ROUTES)('$name takes a body of exactly 48 MiB', async (route) => {
    const f = await fixtures();
    expect(await route.stored(f)).toBe(0);

    const res = await sendWithLength(f, route, paddedJson(route.body, IMAGE_LIMIT));

    expect(res.status).toBe(route.ok);
    expect(await route.stored(f)).toBe(1);
  });

  it.each(IMAGE_ROUTES)(
    '$name refuses a body one byte over 48 MiB with 413 and stores nothing',
    async (route) => {
      const f = await fixtures();

      const res = await sendWithLength(f, route, paddedJson(route.body, IMAGE_LIMIT + 1));

      await expectPayloadTooLarge(res, '48 MiB');
      expect(await route.stored(f)).toBe(0);
    },
  );

  it('refuses a chunked body without Content-Length once it passes 48 MiB, storing nothing', async () => {
    const route = IMAGE_ROUTES[3]!;
    const f = await fixtures();

    const { res } = await sendChunked(f, route, paddedJson(route.body, IMAGE_LIMIT + 1));

    await expectPayloadTooLarge(res, '48 MiB');
    expect(await route.stored(f)).toBe(0);
  });

  it('takes a chunked body of exactly 48 MiB', async () => {
    const route = IMAGE_ROUTES[3]!;
    const f = await fixtures();

    const { res } = await sendChunked(f, route, paddedJson(route.body, IMAGE_LIMIT));

    expect(res.status).toBe(route.ok);
    expect(await route.stored(f)).toBe(1);
  });
});

describe('the size limit of a request body: every other route that reads a body', () => {
  it.each(PLAIN_ROUTES)('$name takes a body of exactly 1 MiB', async (route) => {
    const f = await fixtures();

    const res = await sendWithLength(f, route, paddedJson(route.body, PLAIN_LIMIT));

    expect(res.status).toBe(route.ok);
  });

  it.each(PLAIN_ROUTES)('$name refuses a body one byte over 1 MiB with 413', async (route) => {
    const f = await fixtures();

    const res = await sendWithLength(f, route, paddedJson(route.body, PLAIN_LIMIT + 1));

    await expectPayloadTooLarge(res, '1 MiB');
  });

  // 本文を直に JSON として読む口は、content-type を問わず読む。JSON と名乗らない本文にも上限が効くことを縛る
  it.each(
    PLAIN_ROUTES.filter((route) =>
      ['POST /jobs/manual', 'POST /stop-conditions/parse', 'PUT /settings/backend'].includes(
        route.name,
      ),
    ),
  )(
    '$name refuses a body one byte over 1 MiB with 413 when it is not sent as JSON',
    async (route) => {
      const f = await fixtures();
      const text = paddedJson(route.body, PLAIN_LIMIT + 1);

      const res = await f.api.request(await route.target(f), {
        method: route.method,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(Buffer.byteLength(text)),
        },
        body: text,
      });

      await expectPayloadTooLarge(res, '1 MiB');
    },
  );

  it('refuses a chunked body without Content-Length once it passes 1 MiB, without reading the rest', async () => {
    const route = PLAIN_ROUTES[0]!;
    const f = await fixtures();
    const total = 4 * MIB;

    const { res, pulled } = await sendChunked(f, route, paddedJson(route.body, total));

    await expectPayloadTooLarge(res, '1 MiB');
    expect(pulled()).toBeLessThan(total);
    expect(await f.store.listJobIds()).toEqual([]);
  });

  it('takes a chunked body of exactly 1 MiB', async () => {
    const route = PLAIN_ROUTES[0]!;
    const f = await fixtures();

    const { res } = await sendChunked(f, route, paddedJson(route.body, PLAIN_LIMIT));

    expect(res.status).toBe(route.ok);
    expect(await f.store.listJobIds()).toHaveLength(1);
  });
});

describe('the list of routes that read a body', () => {
  it('has every route that can carry a body, so a new route cannot go without a limit unnoticed', async () => {
    const f = await fixtures();
    const known = new Set([
      ...IMAGE_ROUTES.map((r) => r.name.replace(/ \(.*\)$/, '')),
      ...PLAIN_ROUTES.map((r) => r.name),
      ...ROUTES_THAT_READ_NO_BODY,
    ]);

    const carrying = f.api.routes
      .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))
      .map((r) => `${r.method} ${r.path}`);

    expect(carrying.filter((name) => !known.has(name))).toEqual([]);
    expect(
      [...known].filter((name) => !carrying.includes(name)),
      'a listed route no longer exists',
    ).toEqual([]);
  });
});
