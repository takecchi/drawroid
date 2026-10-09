import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { STUB_PNG } from '@drawroid/core/testing';

const FIXTURE_ROUTES: Record<string, string> = {
  'GET /sdapi/v1/sd-models': 'sd-models.json',
  'GET /sdapi/v1/sd-modules': 'sd-modules.json',
  'GET /sdapi/v1/loras': 'loras.json',
  'GET /sdapi/v1/samplers': 'samplers.json',
  'GET /sdapi/v1/schedulers': 'schedulers.json',
  'GET /sdapi/v1/cmd-flags': 'cmd-flags.json',
};

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type MockHandler = (req: RecordedRequest, res: ServerResponse) => void;

export interface MockForge {
  url: string;
  requests: RecordedRequest[];
  // 1つの経路の応答を差し替える。key は 'GET /sdapi/v1/loras' の形
  route(key: string, handler: MockHandler): void;
  close(): Promise<void>;
}

export function json(status: number, body: unknown): MockHandler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

// txt2img の応答の形は api.py の text2imgapi と processing.py の Processed.js に合わせた。画像は中身の無い PNG を枚数ぶん返す
export const fakeTxt2img: MockHandler = (req, res) => {
  const body = JSON.parse(req.body) as { batch_size?: number; seed?: number };
  const batchSize = body.batch_size ?? 1;
  const firstSeed = body.seed === undefined || body.seed === -1 ? 123456 : body.seed;
  const allSeeds = Array.from({ length: batchSize }, (_, i) => firstSeed + i);
  const info = {
    seed: firstSeed,
    all_seeds: allSeeds,
    infotexts: allSeeds.map((seed) => `a cat\nSteps: 4, Seed: ${seed}`),
    index_of_first_image: 0,
  };
  json(200, {
    images: allSeeds.map(() => Buffer.from(STUB_PNG).toString('base64')),
    parameters: body,
    info: JSON.stringify(info),
  })(req, res);
};

// 試験のための偽の Forge。雛形（fixtures/）の応答を返し、受けた要求を記録する
export async function startMockForge(): Promise<MockForge> {
  const routes = new Map<string, MockHandler>(
    Object.entries(FIXTURE_ROUTES).map(([key, file]) => [key, json(200, fixture(file))]),
  );
  routes.set('POST /sdapi/v1/txt2img', fakeTxt2img);
  routes.set('POST /sdapi/v1/interrupt', json(200, {}));
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://x').pathname,
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const handler = routes.get(`${recorded.method} ${recorded.path}`);
      if (handler === undefined) json(404, { detail: 'Not Found' })(recorded, res);
      else handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    route: (key, handler) => routes.set(key, handler),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// 使われていないポートの URL。繋がらないバックエンドを作るのに使う
export async function unusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
