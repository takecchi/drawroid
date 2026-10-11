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

type Fetch = ReturnType<typeof createApp>['fetch'];

/** 取れたポート。組み立てが済んだら open で要求を受け始め、済まずに終わるなら release で返す */
export interface ClaimedPort {
  address: AddressInfo;
  open(options: { webRoot: string; deps: ApiDeps }): Listening;
  release(): Promise<void>;
}

/**
 * ポートを取る。取れなければ EADDRINUSE などで失敗する。
 * 取ってから open までに来た要求は、断らずに open まで待たせる
 */
// 確かめて閉じてから listen し直さない: 確かめと listen の間に別の drawroid が同じポートを取る窓ができ、
// 起動の行を出したあとで落ちる元の形に戻るため。取ったものをそのまま使う
export function claimPort(port: number): Promise<ClaimedPort> {
  return new Promise((resolve, reject) => {
    let ready!: (fetch: Fetch) => void;
    const app = new Promise<Fetch>((resolveApp) => (ready = resolveApp));
    const server = serve(
      {
        // 組み立ての途中は app が決まらず、要求はここで待つ。release されたら接続ごと閉じるので待ち続けない
        fetch: async (...args: Parameters<Fetch>) => (await app)(...args),
        hostname: HOST,
        port,
      },
      (address) =>
        resolve({
          address,
          open: ({ webRoot, deps }) => {
            ready(createApp({ webRoot, deps }).fetch);
            return { server, address };
          },
          release: () =>
            new Promise<void>((released) => {
              server.close(() => released());
              if ('closeAllConnections' in server) server.closeAllConnections();
            }),
        }),
    );
    server.once('error', reject);
  });
}

export async function listen(options: { port: number; webRoot: string; deps: ApiDeps }) {
  return (await claimPort(options.port)).open(options);
}
