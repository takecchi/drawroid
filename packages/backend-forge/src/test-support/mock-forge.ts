import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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

// 試験のための偽の Forge。雛形（fixtures/）の応答を返し、受けた要求を記録する
export async function startMockForge(): Promise<MockForge> {
  const routes = new Map<string, MockHandler>(
    Object.entries(FIXTURE_ROUTES).map(([key, file]) => [key, json(200, fixture(file))]),
  );
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
