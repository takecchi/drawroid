import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { payloadTooLarge } from './errors.js';

const MIB = 1024 * 1024;
export const MAX_BODY_BYTES = 1 * MIB;
export const MAX_IMAGE_BODY_BYTES = 48 * MIB;

/** base64 の画像を本文に載せる口。ここに無い口は MAX_BODY_BYTES で断る */
export const IMAGE_BODY_ROUTES = [
  { method: 'POST', path: '/jobs/auto' },
  { method: 'POST', path: '/jobs/auto/:jobId/interventions' },
  { method: 'POST', path: '/conversations/:conversationId/uploads' },
] as const;

// 末尾で比べる: createApi が /api の下に付いても、付け先が変わっても、同じ口として見分けるため
const IMAGE_BODY_MATCHERS = IMAGE_BODY_ROUTES.map(({ method, path }) => ({
  method,
  pattern: new RegExp(`${path.replace(/:[^/]+/g, '[^/]+')}/?$`),
}));

function carriesImages(c: Context): boolean {
  return IMAGE_BODY_MATCHERS.some(
    ({ method, pattern }) => c.req.method === method && pattern.test(c.req.path),
  );
}

function limitOf(maxSize: number) {
  return bodyLimit({ maxSize, onError: (c) => payloadTooLarge(c, maxSize) });
}

const plainLimit = limitOf(MAX_BODY_BYTES);
const imageLimit = limitOf(MAX_IMAGE_BODY_BYTES);

// 全体を画像の上限にしない: 設定や発言の口まで 48 MiB を読み込んでから断ることになるため
export const requestBodyLimit: MiddlewareHandler = (c, next) =>
  (carriesImages(c) ? imageLimit : plainLimit)(c, next);
