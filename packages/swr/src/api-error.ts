// API のエラー体 `{ error: { kind, message } }`（packages/api の errors.ts）を画面が扱える形にしたもの。
// 'network'（fetch が投げた）と 'unknown'（体が読めない）は、API の外で起きた失敗に付ける
export class ApiError extends Error {
  readonly kind: string;
  readonly status: number | null;

  constructor(kind: string, message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export async function readApiError(res: {
  status: number;
  json(): Promise<unknown>;
}): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => undefined);
  const error = isRecord(body) ? body.error : undefined;
  if (isRecord(error) && typeof error.kind === 'string' && typeof error.message === 'string') {
    return new ApiError(error.kind, error.message, res.status);
  }
  // 体が API のエラーの形でないとき（プロキシの HTML や、未知の経路の { error: 'not_found' }）も、状態は伝える
  return new ApiError('unknown', `想定外の応答（HTTP ${res.status}）`, res.status);
}

// 例外で扱う: 成功の値と失敗を別の戻り値の形にすると、SWR の error にも、呼び手の try/catch にも載せ替えが要るため
export async function unwrap<T>(
  request: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
): Promise<T> {
  let res;
  try {
    res = await request();
  } catch (cause) {
    throw new ApiError('network', 'drawroid の API に繋がらない', null, { cause });
  }
  if (!res.ok) throw await readApiError(res);
  return (await res.json()) as T;
}
