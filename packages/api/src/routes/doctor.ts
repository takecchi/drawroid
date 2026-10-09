import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { conflict } from '../errors.js';

/**
 * 設定の画面の「確かめる」。drawroid doctor と同じ確かめを走らせ、項目ごとの「よい／足りない」を返す。
 * 外（バックエンド・LLM）へ問い合わせるので、GET にはしない。何も書き換えない
 */
export function doctorRoutes({ doctor }: ApiDeps) {
  return new Hono().post('/', async (c) => {
    if (doctor === undefined) {
      return conflict(
        c,
        'unavailable',
        'この起動では、画面から確かめられない。ターミナルで drawroid doctor を走らせる',
      );
    }
    return c.json({ report: await doctor.run() }, 200);
  });
}
