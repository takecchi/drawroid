import { BackendError } from '@drawroid/core';
import type { z } from 'zod';

export interface ForgeConnection {
  // Forge の起点の URL（例: http://127.0.0.1:7860）
  baseUrl: string;
  // Forge を --api-auth 付きで起動しているときだけ渡す
  auth?: { username: string; password: string };
  // 1回の HTTP 呼び出しを待つ上限。呼び出しごとに上書きできる
  timeoutMs: number;
  fetch?: typeof fetch;
}

// 接続に失敗したときの cause.code。どれも「その URL の先に Forge がいない」ことを指す
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export interface CallOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export class ForgeClient {
  private readonly baseUrl: URL;
  private readonly authHeader: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(connection: ForgeConnection) {
    this.baseUrl = parseBaseUrl(connection.baseUrl);
    this.authHeader =
      connection.auth === undefined
        ? undefined
        : `Basic ${btoa(`${connection.auth.username}:${connection.auth.password}`)}`;
    this.timeoutMs = connection.timeoutMs;
    this.fetchImpl = connection.fetch ?? fetch;
  }

  get origin(): string {
    return this.baseUrl.href;
  }

  async getJson<S extends z.ZodType>(path: string, schema: S, options: CallOptions = {}) {
    return this.requestJson(path, { method: 'GET' }, schema, options);
  }

  async postJson<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
    options: CallOptions = {},
  ) {
    return this.requestJson(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      schema,
      options,
    );
  }

  private async requestJson<S extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: S,
    { signal, timeoutMs = this.timeoutMs }: CallOptions,
  ): Promise<z.infer<S>> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    const where = `${init.method} ${url.pathname}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    if (signal?.aborted) throw new BackendError('aborted', `${where}: 呼び手が止めた`);

    let res: Response;
    let text: string;
    try {
      const headers = new Headers(init.headers);
      if (this.authHeader !== undefined) headers.set('authorization', this.authHeader);
      res = await this.fetchImpl(url, { ...init, headers, signal: combined });
      text = await res.text();
    } catch (error) {
      throw classifyFetchError(error, where, this.baseUrl.href, signal, timeout, timeoutMs);
    }

    if (!res.ok) throw classifyStatus(res.status, text, where, this.baseUrl.href);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new BackendError('bad_response', `${where}: 応答が JSON ではない`, { cause: error });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BackendError('bad_response', `${where}: 応答の形が想定と違う`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}

function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Forge の URL として読めない: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Forge の URL は http か https で始める: ${raw}`);
  }
  // 末尾の / を揃える: 無いと、相対パスの解決で最後のセグメント（/forge など）が落ちるため
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function classifyFetchError(
  error: unknown,
  where: string,
  baseUrl: string,
  signal: AbortSignal | undefined,
  timeout: AbortSignal,
  timeoutMs: number,
): BackendError {
  if (signal?.aborted)
    return new BackendError('aborted', `${where}: 呼び手が止めた`, { cause: error });
  if (timeout.aborted) {
    return new BackendError('timeout', `${where}: ${timeoutMs}ms 待っても応答が無い`, {
      cause: error,
    });
  }
  const code = causeCode(error);
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return new BackendError(
      'unreachable',
      `${baseUrl} に繋がらない（${code}）。Forge が起動しているか、URL とポートが合っているかを確かめる`,
      { cause: error },
    );
  }
  // 原因の連鎖を最後までたどって書く: fetch は「fetch failed」とだけ言い、本当の理由（ポートが使えない・名前が引けない など）は cause の奥にあるため
  return new BackendError(
    'unreachable',
    `${baseUrl} に繋がらない（${causeMessages(error)}）。URL の書き方とポートが合っているかを確かめる（${where}）`,
    { cause: error },
  );
}

function causeMessages(error: unknown): string {
  const messages: string[] = [];
  for (let e: unknown = error; e !== undefined && e !== null;) {
    messages.push(e instanceof Error ? e.message : String(e));
    e = typeof e === 'object' && 'cause' in e ? e.cause : undefined;
  }
  return messages.join(': ');
}

function causeCode(error: unknown): string | undefined {
  for (let e: unknown = error; e !== null && typeof e === 'object';) {
    if ('code' in e && typeof e.code === 'string') return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}

function classifyStatus(status: number, body: string, where: string, baseUrl: string) {
  if (status === 401 || status === 403) {
    return new BackendError(
      'unauthorized',
      `${where}: 認証に失敗した（HTTP ${status}）。Forge の --api-auth と設定の認証情報を確かめる`,
    );
  }
  if (status === 404) {
    return new BackendError(
      'not_found',
      `${where}: API が無い（HTTP 404）。${baseUrl} が Forge の URL か、Forge を --api 付きで起動しているかを確かめる`,
    );
  }
  return new BackendError(
    'failed',
    `${where}: Forge が失敗を返した（HTTP ${status}）${detailOf(body)}`,
  );
}

// Forge（FastAPI）の失敗の応答は {detail} か {error, errors} の形で理由を返す
function detailOf(body: string): string {
  try {
    const json: unknown = JSON.parse(body);
    if (json !== null && typeof json === 'object') {
      for (const key of ['detail', 'errors', 'error']) {
        const value = (json as Record<string, unknown>)[key];
        if (value !== undefined && value !== null && value !== '') {
          return `: ${typeof value === 'string' ? value : JSON.stringify(value)}`.slice(0, 500);
        }
      }
    }
  } catch {
    // 本文が JSON でなければ、理由は付けない
  }
  return '';
}
