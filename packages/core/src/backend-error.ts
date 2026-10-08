export const BACKEND_ERROR_KINDS = [
  // 接続できない（落ちている・ポートが違う）
  'unreachable',
  // 繋がったが API が無い（URL が違う・API が有効になっていない）
  'not_found',
  // 認証に失敗した
  'unauthorized',
  // 時間内に応答が無かった
  'timeout',
  // 呼び手が signal で止めた
  'aborted',
  // 応答の形が想定と違う
  'bad_response',
  // バックエンドが処理に失敗したと返した（メモリ不足など）
  'failed',
] as const;
export type BackendErrorKind = (typeof BACKEND_ERROR_KINDS)[number];

// 原因の種類を持たせる: 人間が「Forge が落ちている」のか「URL が違う」のかを UI で見分けられるようにするため
export class BackendError extends Error {
  readonly kind: BackendErrorKind;

  constructor(kind: BackendErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackendError';
    this.kind = kind;
  }
}

export function isBackendError(error: unknown): error is BackendError {
  return error instanceof BackendError;
}
