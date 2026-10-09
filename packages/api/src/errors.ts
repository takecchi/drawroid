import { isBackendError } from '@drawroid/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodError } from 'zod';

export type ApiErrorBody = { error: { kind: string; message: string } };

function errorBody(kind: string, message: string): ApiErrorBody {
  return { error: { kind, message } };
}

export function invalidRequest(c: Context, message: string) {
  return c.json(errorBody('invalid_request', message), 400);
}

export function conflict(c: Context, kind: string, message: string) {
  return c.json(errorBody(kind, message), 409);
}

export function notFound(c: Context, message: string) {
  return c.json(errorBody('not_found', message), 404);
}

// kind はバックエンドのエラーの種類をそのまま返す: 画面が「落ちている」のか「URL が違う」のかを見分けられるようにするため
export function backendFailure(c: Context, error: unknown) {
  if (!isBackendError(error)) throw error;
  return c.json(errorBody(error.kind, error.message), 502 satisfies ContentfulStatusCode);
}

// 保存されている設定が壊れているのは呼び手の誤りではないので、400 ではなく 500 にする
export function invalidConfig(c: Context, message: string) {
  return c.json(errorBody('invalid_config', message), 500);
}

/** 入力の値を含めない: 値が API キーなどの秘密でも応答に出さないため */
export function describeIssues(error: ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(body)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

// 500 にしない: 人間が手で触って壊したファイルは、サーバの不具合ではなくデータの問題として画面に見せたいため
export function invalidFile(c: Context, message: string) {
  return c.json(errorBody('invalid_file', message), 422);
}
