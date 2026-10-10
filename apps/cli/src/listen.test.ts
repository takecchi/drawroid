import http from 'node:http';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

import { describe, expect, it } from 'vitest';

import { stubDeps } from './test-support.js';

import { DEFAULT_PORT, HOST, listen } from './listen.js';

const webRoot = fileURLToPath(new URL('./test-fixtures/web', import.meta.url));

describe('listen', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { server, address } = await listen({ port: 0, webRoot, deps: stubDeps() });
    try {
      expect(address.address).toBe('127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  // fetch は Host を差し替えられないので、node:http で、向け直された名前の Host を送る（DNS rebinding のブラウザと同じ）
  it('refuses a request whose Host names another site, over the real server', async () => {
    const { server, address } = await listen({ port: 0, webRoot, deps: stubDeps() });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/settings/llm',
            headers: { host: `attacker.example:${address.port}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('defaults to a port that does not collide with Forge / A1111 or ComfyUI', () => {
    expect(HOST).toBe('127.0.0.1');
    expect([7860, 8188]).not.toContain(DEFAULT_PORT);
  });

  // @hono/node-server の writeFromReadableStream は、塊を書くたびに次の読みを返して Promise の鎖を伸ばす（2.1.4 でも同じ）。
  // patches/ で `return` を外している。依存の版を上げてパッチが外れたら、ここが赤になる
  it('does not keep a promise for each chunk an open SSE stream has sent', async () => {
    const deps = stubDeps();
    const { server, address } = await listen({ port: 0, webRoot, deps });
    const controller = new AbortController();
    try {
      const { conversationId } = await deps.conversations.store.createConversation(new Date());
      const hub = deps.conversations.hubs.get(conversationId);
      const res = await fetch(
        `http://127.0.0.1:${address.port}/api/conversations/${conversationId}/stream`,
        { signal: controller.signal },
      );
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let received = 0;
      let text = '';
      const send = async (count: number) => {
        for (let i = 0; i < count; i += 1) {
          const target = received + 1;
          hub.live({
            type: 'generation.progress',
            jobId: 'job',
            iteration: 1,
            progress: i / count,
          });
          // 1件ずつ受け取ってから次を流す: 塊を1つずつ書かせ、書き手の詰まり（drain 待ち）の経路に入らないため
          while (received < target) {
            const { value, done } = await reader.read();
            if (done) throw new Error('SSE が閉じた');
            text += value;
            const blocks = text.split('\n\n');
            text = blocks.pop()!;
            received += blocks.filter((block) =>
              block.includes('event: generation.progress'),
            ).length;
          }
        }
      };
      await send(50);
      const before = v8.queryObjects(Promise, { format: 'count' });
      await send(1000);
      const after = v8.queryObjects(Promise, { format: 'count' });
      // 鎖が伸びると、塊1つにつき1つ残る（1000 増える）。直っていれば、塊の数に比例しない揺れだけになる
      expect(after - before).toBeLessThan(100);
    } finally {
      controller.abort();
      server.close();
    }
  });

  it('rejects when the port is already taken', async () => {
    const first = await listen({ port: 0, webRoot, deps: stubDeps() });
    try {
      await expect(
        listen({ port: first.address.port, webRoot, deps: stubDeps() }),
      ).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      first.server.close();
    }
  });
});
