import type { AddressInfo } from 'node:net';

import type { ApiDeps } from '@drawroid/api';
import { serve, type ServerType } from '@hono/node-server';

import { createApp } from './server.js';

// 待ち受けのアドレスを引数で変えさせない: 公開サーバとしての運用は PRD のスコープ外で、手元の端末の外から触れる経路を作らないため
export const HOST = '127.0.0.1';
// Forge / A1111（7860）・ComfyUI（8188）と衝突しない値
export const DEFAULT_PORT = 7878;

export interface Listening {
  server: ServerType;
  address: AddressInfo;
}

export function listen({
  port,
  webRoot,
  deps,
}: {
  port: number;
  webRoot: string;
  deps: ApiDeps;
}): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: createApp({ webRoot, deps }).fetch, hostname: HOST, port },
      (address) => resolve({ server, address }),
    );
    server.once('error', reject);
  });
}
