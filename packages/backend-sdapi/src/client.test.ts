import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BackendError } from '@drawroid/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SdapiClient } from './client.js';

/** いま誰も待ち受けていない URL */
async function unusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('SdapiClient', () => {
  it('names the product in the advice when the backend cannot be reached', async () => {
    const client = new SdapiClient({
      product: 'A1111',
      baseUrl: await unusedUrl(),
      timeoutMs: 5000,
    });

    const error: unknown = await client.getJson('/sdapi/v1/cmd-flags', z.unknown()).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).kind).toBe('unreachable');
    expect((error as BackendError).message).toContain('A1111 が起動しているか');
  });

  it('names the product when the URL cannot be read', () => {
    expect(() => new SdapiClient({ product: 'A1111', baseUrl: 'not a url', timeoutMs: 1 })).toThrow(
      'A1111 の URL として読めない',
    );
  });

  it.each([
    [401, 'unauthorized', 'A1111 の --api-auth'],
    [404, 'not_found', 'A1111 を --api 付きで起動しているか'],
    [500, 'failed', 'A1111 が失敗を返した'],
  ] as const)(
    'names the product when the backend answers HTTP %i',
    async (status, kind, advice) => {
      // その状態だけを返す偽のバックエンド
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: '理由' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const client = new SdapiClient({
          product: 'A1111',
          baseUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 5000,
        });
        const error: unknown = await client.getJson('/sdapi/v1/cmd-flags', z.unknown()).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(BackendError);
        expect((error as BackendError).kind).toBe(kind);
        // どちらのバックエンドの失敗かが文から分かる（Forge と書かない）
        expect((error as BackendError).message).toContain(advice);
        expect((error as BackendError).message).not.toContain('Forge');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  // 失敗の文から、どちらのバックエンドの失敗かが分かる（ジョブの止まった理由やログには、画面の補いが付かないため）
  describe.each(['Forge', 'A1111'])('naming %s in every failure', (product) => {
    const other = product === 'Forge' ? 'A1111' : 'Forge';
    async function failureWith(fakeFetch: typeof fetch, timeoutMs = 5000) {
      const client = new SdapiClient({
        product,
        baseUrl: 'http://127.0.0.1:7860',
        timeoutMs,
        fetch: fakeFetch,
      });
      const error: unknown = await client
        .getJson('/sdapi/v1/cmd-flags', z.object({ ok: z.boolean() }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(BackendError);
      return error as BackendError;
    }

    it.each([
      [
        'times out',
        'timeout',
        // 止められるまで返らない
        ((_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          )) as typeof fetch,
        20,
      ],
      [
        'answers a body that is not JSON',
        'bad_response',
        (async () => new Response('<html>')) as typeof fetch,
        5000,
      ],
      [
        'answers JSON of another shape',
        'bad_response',
        (async () => new Response('{"ok":"yes"}')) as typeof fetch,
        5000,
      ],
      [
        'cannot be reached for a reason without a known code',
        'unreachable',
        (async () => {
          throw new TypeError('fetch failed', { cause: new Error('何かが起きた') });
        }) as typeof fetch,
        5000,
      ],
    ] as const)('when it %s', async (_case, kind, fakeFetch, timeoutMs) => {
      const error = await failureWith(fakeFetch, timeoutMs);

      expect(error.kind).toBe(kind);
      expect(error.message).toContain(product);
      expect(error.message).not.toContain(other);
    });
  });
});

/** 決めた応答を返し、受けた要求を数える偽のサーバ */
async function serverAnswering(
  answer: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{
  url: string;
  requests: { method: string; path: string; body: string }[];
  close: () => Promise<void>;
}> {
  const requests: { method: string; path: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      answer(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function failureOf(call: Promise<unknown>): Promise<BackendError> {
  const error: unknown = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BackendError);
  return error as BackendError;
}

describe('SdapiClient, sent elsewhere by a redirect', () => {
  // 悪意のある・壊れたバックエンドが、別のオリジン（手元の別のサービスなど）へ飛ばしても、追わずに止める
  it.each([
    ['GET', 302],
    ['POST', 307],
  ] as const)('does not follow a %s redirect to another origin', async (method, status) => {
    const elsewhere = await serverAnswering((_req, res) => res.end('{"secret":"x"}'));
    const backend = await serverAnswering((_req, res) => {
      res.writeHead(status, { location: `${elsewhere.url}/internal` });
      res.end();
    });
    try {
      const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });
      const call =
        method === 'GET'
          ? client.getJson('/sdapi/v1/options', z.unknown())
          : client.postJson('/sdapi/v1/txt2img', { prompt: 'a cat' }, z.unknown());

      const error = await failureOf(call);

      expect(error.kind).toBe('bad_response');
      expect(error.message).toContain('Forge');
      expect(error.message).toContain('別の場所');
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await backend.close();
      await elsewhere.close();
    }
  });

  // 同じオリジンの中で移る（末尾の / を足すなど）のは、今までどおり追う
  it('follows a redirect within the same origin', async () => {
    const backend = await serverAnswering((req, res) => {
      if (req.url === '/sdapi/v1/options') {
        res.writeHead(307, { location: '/sdapi/v1/options/' });
        res.end();
        return;
      }
      res.end('{"ok":true}');
    });
    try {
      const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });

      expect(await client.getJson('/sdapi/v1/options', z.unknown())).toEqual({ ok: true });
      expect(backend.requests.map((r) => r.path)).toEqual([
        '/sdapi/v1/options',
        '/sdapi/v1/options/',
      ]);
    } finally {
      await backend.close();
    }
  });

  /** path へ来た要求だけ、status で末尾に / を足した先へ移るよう返すバックエンド */
  const movingBackend = (path: string, status: number) =>
    serverAnswering((req, res) => {
      if (req.url === path) {
        res.writeHead(status, { location: `${path}/` });
        res.end();
        return;
      }
      res.end('{"ok":true}');
    });

  // POST を 301・302・303 で移されたら追わない: 追うと GET に変えて本文なしで送り直すことになり、生成の要求として意味を成さないため
  it.each([301, 302, 303])(
    'does not follow a %s redirect of a POST, even within the same origin',
    async (status) => {
      const backend = await movingBackend('/sdapi/v1/txt2img', status);
      try {
        const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });

        const error = await failureOf(
          client.postJson('/sdapi/v1/txt2img', { prompt: 'a cat' }, z.unknown()),
        );

        expect(error.kind).toBe('bad_response');
        expect(error.message).toContain('Forge');
        expect(error.message).toContain(String(status));
        expect(error.message).toContain('GET');
        expect(backend.requests.map((r) => r.path)).toEqual(['/sdapi/v1/txt2img']);
      } finally {
        await backend.close();
      }
    },
  );

  // 307・308 は、POST のまま同じ本文で送り直すので、同じオリジンの中なら追う
  it.each([307, 308])('follows a %s redirect of a POST within the same origin', async (status) => {
    const backend = await movingBackend('/sdapi/v1/txt2img', status);
    try {
      const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });

      expect(await client.postJson('/sdapi/v1/txt2img', { prompt: 'a cat' }, z.unknown())).toEqual({
        ok: true,
      });
      expect(backend.requests).toEqual([
        { method: 'POST', path: '/sdapi/v1/txt2img', body: '{"prompt":"a cat"}' },
        { method: 'POST', path: '/sdapi/v1/txt2img/', body: '{"prompt":"a cat"}' },
      ]);
    } finally {
      await backend.close();
    }
  });

  // GET は、どの移り方でも今までどおり追う
  it.each([301, 302, 303])(
    'follows a %s redirect of a GET within the same origin',
    async (status) => {
      const backend = await movingBackend('/sdapi/v1/options', status);
      try {
        const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });

        expect(await client.getJson('/sdapi/v1/options', z.unknown())).toEqual({ ok: true });
        expect(backend.requests.map((r) => r.path)).toEqual([
          '/sdapi/v1/options',
          '/sdapi/v1/options/',
        ]);
      } finally {
        await backend.close();
      }
    },
  );
});

describe('SdapiClient, answered with too much', () => {
  it('stops reading an answer past the size it allows, saying so', async () => {
    const backend = await serverAnswering((_req, res) =>
      res.end(JSON.stringify({ text: 'x'.repeat(5000) })),
    );
    try {
      const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });

      const error = await failureOf(
        client.getJson('/sdapi/v1/options', z.unknown(), { maxBytes: 1000 }),
      );

      expect(error.kind).toBe('bad_response');
      expect(error.message).toContain('Forge の応答が大きすぎる');
    } finally {
      await backend.close();
    }
  });

  it('reads an answer within the size it allows', async () => {
    const backend = await serverAnswering((_req, res) =>
      res.end(JSON.stringify({ text: 'x'.repeat(900) })),
    );
    try {
      const client = new SdapiClient({ product: 'Forge', baseUrl: backend.url, timeoutMs: 5000 });

      expect(
        await client.getJson('/sdapi/v1/options', z.object({ text: z.string() }), {
          maxBytes: 1000,
        }),
      ).toEqual({ text: 'x'.repeat(900) });
    } finally {
      await backend.close();
    }
  });
});
