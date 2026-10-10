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
  const storage = describeStorageFailure(error);
  if (storage !== undefined) {
    // 置き場所は端末にだけ出す（応答には出さない）。積み上げは出さない: 権限や空きの問題で、コードの不具合ではないため
    const path = (error as NodeJS.ErrnoException).path;
    console.error(`drawroid: ${storage.said}${path === undefined ? '' : `: ${path}`}`);
    return c.json(errorBody('storage_failed', `${storage.said}。${storage.next}`), 500);
  }
  console.error(error);
  return c.json(errorBody('internal_error', 'サーバの中で想定外の失敗があった'), 500);
}

/** データディレクトリの読み書きの失敗を、何が起きたかと次に何をするかの言葉にする。ほかの失敗は undefined */
export function describeStorageFailure(error: unknown): { said: string; next: string } | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return {
        said: `データディレクトリを読み書きできなかった（${code}）`,
        next: 'drawroid を動かしているユーザーが、データディレクトリに書けるかを確かめる。置き場所は drawroid の端末に出した',
      };
    case 'EROFS':
      return {
        said: 'データディレクトリが読み取り専用で、書けなかった（EROFS）',
        next: '書ける場所を --data-dir で指して、drawroid を起動し直す',
      };
    case 'ENOSPC':
      return {
        said: 'ディスクの空きが足りず、データディレクトリに書けなかった（ENOSPC）',
        next: '空きを作ってから、もう一度行う',
      };
    default:
      return undefined;
  }
}

export function invalidRequest(c: Context, message: string) {
  return c.json(errorBody('invalid_request', message), 400);
}

export function payloadTooLarge(c: Context, maxBytes: number) {
  return c.json(
    errorBody('payload_too_large', `本文が大きすぎる（上限 ${maxBytes / (1024 * 1024)} MiB）`),
    413,
  );
}

/** 要求は正しいが、対象の今の状態では受けられない（止まったジョブへの口出し・走っている生成など） */
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
