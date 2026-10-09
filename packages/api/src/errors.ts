import { isBackendError } from '@drawroid/core';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodError } from 'zod';

export type ApiErrorBody = { error: { kind: string; message: string } };

function errorBody(kind: string, message: string): ApiErrorBody {
  return { error: { kind, message } };
}

/**
 * ルートの外で投げられた例外を、ほかのエラーと同じ `{ error: { kind, message } }` の形で返す（アプリ全体の受け口）。
 * hono が投げる HTTPException（読めない本文など）はその状態のまま、それ以外は 500 にする。
 */
// 想定外の例外の文面を返さない: 置き場所のパスや設定の中身が、応答に出ないようにするため
export function handleUncaught(error: Error, c: Context) {
  if (error instanceof HTTPException) {
    const status = error.status as ContentfulStatusCode;
    const kind = status === 400 ? 'invalid_request' : 'http_error';
    return c.json(errorBody(kind, error.message), status);
  }
  console.error(error);
  return c.json(errorBody('internal_error', 'サーバの中で想定外の失敗があった'), 500);
}

export function invalidRequest(c: Context, message: string) {
  return c.json(errorBody('invalid_request', message), 400);
}

export function notFound(c: Context, message: string) {
  return c.json(errorBody('not_found', message), 404);
}

/**
 * 要求は正しいが、対象の今の状態では受けられない（止まったジョブへの口出し、生成中の繋ぎ直しなど）。
 * 画面が理由を見分ける必要があるときだけ kind を渡す
 */
export function conflict(c: Context, message: string, kind = 'conflict') {
  return c.json(errorBody(kind, message), 409);
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
