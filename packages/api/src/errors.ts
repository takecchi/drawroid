import { isBackendError } from '@drawroid/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ApiErrorBody = { error: { kind: string; message: string } };

function errorBody(kind: string, message: string): ApiErrorBody {
  return { error: { kind, message } };
}

export function invalidRequest(c: Context, message: string) {
  return c.json(errorBody('invalid_request', message), 400);
}

export function notFound(c: Context, message: string) {
  return c.json(errorBody('not_found', message), 404);
}

// kind はバックエンドのエラーの種類をそのまま返す: 画面が「落ちている」のか「URL が違う」のかを見分けられるようにするため
export function backendFailure(c: Context, error: unknown) {
  if (!isBackendError(error)) throw error;
  return c.json(errorBody(error.kind, error.message), 502 satisfies ContentfulStatusCode);
}
