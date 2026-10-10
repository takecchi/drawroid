// 画像を受ける4つの口が、受け付けの時点で画像を読んで確かめること（読めない・大きすぎる・宣言と中身が違う）
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  basicPermissions,
  generationRequestSchema,
  JobRunner,
} from '@drawroid/core';
import { ScriptedLlm, STUB_PNG, StubBackend } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  memoryConversations,
  setup,
  signatureOnly,
  solidImage,
  type ImageFormat,
} from './test-support.js';

const MAX_EDGE = 8192;
const FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp'];
const MEDIA_TYPE = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;

type Mouth = {
  /** この口が受ける形式 */
  formats: ImageFormat[];
  acceptedStatus: number;
  send(image: Uint8Array, declared: ImageFormat): Promise<Response>;
  /** 保存された数 */
  saved(): Promise<number>;
};

const MOUTHS = [
  'references of POST /jobs/auto',
  'reference of POST /jobs/auto/:jobId/interventions',
  'mask of POST /jobs/auto/:jobId/interventions',
  'POST /conversations/:conversationId/uploads',
] as const;
type MouthName = (typeof MOUTHS)[number];

let roots: string[] = [];
let api: Awaited<ReturnType<typeof setup>>['api'];
let store: FsJobStore;
let addUpload: ReturnType<typeof vi.spyOn>;
let conversationId: string;

const post = async (path: string, body: unknown) =>
  api.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function prepare(): Promise<Record<MouthName, Mouth>> {
  const created = await post('/jobs/auto', { request: '夕暮れの海辺の少女' });
  const { jobId } = (await created.json()) as { jobId: string };
  await store.writeGeneration(
    jobId,
    1,
    generationRequestSchema.parse({ prompt: 'a', steps: 4, cfgScale: 7, width: 64, height: 64 }),
    { images: [{ png: STUB_PNG, seed: 1, metadata: {} }], metadata: {} },
  );
  const conversation = await post('/conversations', {});
  conversationId = ((await conversation.json()) as { conversation: { conversationId: string } })
    .conversation.conversationId;
  const jobsBefore = (await store.listJobIds()).length;
  return {
    'references of POST /jobs/auto': {
      formats: FORMATS,
      acceptedStatus: 202,
      send: (image, declared) =>
        post('/jobs/auto', {
          request: '海辺',
          references: [{ mediaType: MEDIA_TYPE[declared], data: b64(image) }],
        }),
      saved: async () => (await store.listJobIds()).length - jobsBefore,
    },
    'reference of POST /jobs/auto/:jobId/interventions': {
      formats: FORMATS,
      acceptedStatus: 202,
      send: (image, declared) =>
        post(`/jobs/auto/${jobId}/interventions`, {
          kind: 'reference',
          image: { mediaType: MEDIA_TYPE[declared], data: b64(image) },
        }),
      saved: async () => (await store.listReferences(jobId)).length,
    },
    'mask of POST /jobs/auto/:jobId/interventions': {
      formats: ['png'],
      acceptedStatus: 202,
      send: (image) =>
        post(`/jobs/auto/${jobId}/interventions`, {
          kind: 'mask',
          image: { iteration: 1, index: 0 },
          mask: { data: b64(image) },
        }),
      saved: async () => (await store.listInterventions(jobId)).length,
    },
    'POST /conversations/:conversationId/uploads': {
      formats: FORMATS,
      acceptedStatus: 201,
      send: (image, declared) =>
        post(`/conversations/${conversationId}/uploads`, {
          mediaType: MEDIA_TYPE[declared],
          data: b64(image),
        }),
      saved: async () => addUpload.mock.calls.length,
    },
  };
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'drawroid-api-image-upload-'));
  roots.push(root);
  store = new FsJobStore(root);
  const backend = new StubBackend();
  const runner = new JobRunner({
    store,
    llm: new ScriptedLlm({}),
    backend,
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
  });
  const conversations = memoryConversations();
  addUpload = vi.spyOn(conversations.store, 'addUpload');
  ({ api } = await setup({
    store,
    backend,
    conversations,
    autoQueue: {
      kick: () => undefined,
      stop: (jobId) => runner.stop(jobId),
      addInstruction: (jobId, text) => runner.addInstruction(jobId, text),
      changeStopConditions: (jobId, change) => runner.changeStopConditions(jobId, change),
      addReference: (jobId, reference) => runner.addReference(jobId, reference),
      addMask: (jobId, mask) => runner.addMask(jobId, mask),
    },
  }));
});
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

// 8192 四方の単色の画像は、作るのに時間がかかるので、形式ごとに1度だけ作る
const largest = new Map<ImageFormat, Promise<Uint8Array>>();
const largestOf = (format: ImageFormat) => {
  let image = largest.get(format);
  if (image === undefined) {
    image = solidImage(format, MAX_EDGE, MAX_EDGE);
    largest.set(format, image);
  }
  return image;
};
afterAll(() => largest.clear());

async function refusal(res: Response) {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { kind: string; message: string } }).error;
}

describe.each(MOUTHS)('%s', (name) => {
  const formatsOf = (mouth: Mouth) => mouth.formats;

  it('refuses an image that has only the right signature, saving nothing', async () => {
    const mouth = (await prepare())[name];

    for (const format of formatsOf(mouth)) {
      const error = await refusal(await mouth.send(signatureOnly(format), format));
      expect(error.kind, format).toBe('invalid_request');
      expect(error.message, format).toContain('読めない');
    }

    expect(await mouth.saved()).toBe(0);
  });

  it('refuses an image wider than 8192 px, saving nothing', async () => {
    const mouth = (await prepare())[name];

    for (const format of formatsOf(mouth)) {
      const error = await refusal(
        await mouth.send(await solidImage(format, MAX_EDGE + 1, 1), format),
      );
      expect(error.kind, format).toBe('invalid_request');
      expect(error.message, format).toContain(String(MAX_EDGE));
    }

    expect(await mouth.saved()).toBe(0);
  });

  it('refuses an image taller than 8192 px, saving nothing', async () => {
    const mouth = (await prepare())[name];

    for (const format of formatsOf(mouth)) {
      const error = await refusal(
        await mouth.send(await solidImage(format, 1, MAX_EDGE + 1), format),
      );
      expect(error.kind, format).toBe('invalid_request');
      expect(error.message, format).toContain(String(MAX_EDGE));
    }

    expect(await mouth.saved()).toBe(0);
  });

  it('accepts an image of exactly 8192 x 8192 px', async () => {
    const mouth = (await prepare())[name];

    for (const format of formatsOf(mouth)) {
      const res = await mouth.send(await largestOf(format), format);
      expect(res.status, format).toBe(mouth.acceptedStatus);
    }

    expect(await mouth.saved()).toBe(formatsOf(mouth).length);
  }, 60_000);

  it('accepts a small valid image of each format it takes', async () => {
    const mouth = (await prepare())[name];

    for (const format of formatsOf(mouth)) {
      const res = await mouth.send(await solidImage(format, 16, 8), format);
      expect(res.status, format).toBe(mouth.acceptedStatus);
    }

    expect(await mouth.saved()).toBe(formatsOf(mouth).length);
  });
});

describe('an image whose content is not the type it says', () => {
  it.each(MOUTHS.filter((name) => !name.startsWith('mask')))(
    'is refused by %s, saving nothing',
    async (name) => {
      const mouth = (await prepare())[name];

      await refusal(await mouth.send(await solidImage('png', 4, 4), 'jpeg'));
      await refusal(await mouth.send(await solidImage('webp', 4, 4), 'png'));

      expect(await mouth.saved()).toBe(0);
    },
  );
});

describe('several references in one submission', () => {
  it('starts no job when one of them cannot be read', async () => {
    await prepare();
    const before = await store.listJobIds();

    const res = await post('/jobs/auto', {
      request: '海辺',
      references: [
        { mediaType: 'image/png', data: b64(await solidImage('png', 4, 4)) },
        { mediaType: 'image/png', data: b64(signatureOnly('png')) },
      ],
    });

    await refusal(res);
    expect(await store.listJobIds()).toEqual(before);
  });
});
