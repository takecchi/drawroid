import { BackendError } from '@drawroid/core';
import type { z } from 'zod';

export interface SdapiConnection {
  // エラーの文面に出す製品名（Forge・A1111）。人間が、どれの設定を確かめればよいかを読めるように
  product: string;
  // 起点の URL（例: http://127.0.0.1:7860）
  baseUrl: string;
  // --api-auth 付きで起動しているときだけ渡す
  auth?: { username: string; password: string };
  // 1回の HTTP 呼び出しを待つ上限。呼び出しごとに上書きできる
  timeoutMs: number;
  fetch?: typeof fetch;
}

// 接続に失敗したときの cause.code。どれも「その URL の先にバックエンドがいない」ことを指す
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

/** バックエンドが返す画像1枚の大きさの上限（PNG・途中の画像を戻したあとのバイト数） */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MEGABYTE = 1024 * 1024;
/** 画像1枚を base64 にしたときの長さの上限 */
const MAX_IMAGE_BASE64_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
/** 画像のほかに応答に載る分（info・欄の名前など）の余裕 */
const RESPONSE_SLACK_BYTES = MEGABYTE;
/** 応答の本文の大きさの既定の上限。画像を返さない口と、途中の画像1枚を返す進み具合の口に足りる */
export const DEFAULT_MAX_RESPONSE_BYTES = MAX_IMAGE_BASE64_BYTES + RESPONSE_SLACK_BYTES;
/** 同じオリジンの中で追うリダイレクトの回数の上限 */
const MAX_REDIRECTS = 5;

/** 画像を images 枚まで返す応答の、本文の大きさの上限 */
export function responseLimitForImages(images: number): number {
  return images * MAX_IMAGE_BASE64_BYTES + RESPONSE_SLACK_BYTES;
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  // 応答の本文の大きさの上限（バイト）。省けば DEFAULT_MAX_RESPONSE_BYTES
  maxBytes?: number;
}

/**
 * Forge・A1111 に共通の /sdapi/v1 の HTTP の呼び出し。応答をスキーマで検証し、失敗を種類に分ける。
 */
export class SdapiClient {
  readonly product: string;
  private readonly baseUrl: URL;
  private readonly authHeader: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(connection: SdapiConnection) {
    this.product = connection.product;
    this.baseUrl = parseBaseUrl(connection.baseUrl, connection.product);
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
    { signal, timeoutMs = this.timeoutMs, maxBytes = DEFAULT_MAX_RESPONSE_BYTES }: CallOptions,
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
      res = await this.fetchFollowingSameOrigin(url, { ...init, headers, signal: combined }, where);
      text = await readTextWithin(res, maxBytes, where, this.product);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw classifyFetchError(error, {
        where,
        baseUrl: this.baseUrl.href,
        product: this.product,
        signal,
        timeout,
        timeoutMs,
      });
    }

    if (!res.ok) throw classifyStatus(res.status, text, where, this.baseUrl.href, this.product);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new BackendError('bad_response', `${where}: ${this.product} の応答が JSON ではない`, {
        cause: error,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BackendError('bad_response', `${where}: ${this.product} の応答の形が想定と違う`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  /**
   * リダイレクトを自分で辿る。同じオリジンの中なら追い、別のオリジンへ移るよう返されたら追わずに失敗にする。
   */
  // 自動では追わない: 壊れた・悪意のあるバックエンドが別のオリジン（手元の別のサービスなど）へ飛ばすと、
  // プロンプトや画像の本文がそこへ送り直され、その応答の文面が失敗の理由として画面と LLM に載るため
  private async fetchFollowingSameOrigin(
    url: URL,
    init: RequestInit,
    where: string,
  ): Promise<Response> {
    let target = url;
    for (let hops = 0; ; hops += 1) {
      const res = await this.fetchImpl(target, { ...init, redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || location === null) return res;
      await res.body?.cancel();
      const next = new URL(location, target);
      if (next.origin !== this.baseUrl.origin) {
        throw new BackendError(
          'bad_response',
          `${where}: ${this.product} が別の場所（${next.origin}）へ移るよう返したので、追わずに止めた。${this.product} の URL（${this.baseUrl.href}）が合っているかを確かめる`,
        );
      }
      if (hops >= MAX_REDIRECTS) {
        throw new BackendError(
          'bad_response',
          `${where}: ${this.product} が ${MAX_REDIRECTS} 回を超えて移るよう返したので、追うのをやめた`,
        );
      }
      target = next;
    }
  }
}

/** 応答の本文を、maxBytes まで読む。超えたら読むのをやめて失敗にする */
// 全部読んでから確かめない: 大きすぎる応答を読み切るだけで、メモリを使い切ることがあるため
async function readTextWithin(
  res: Response,
  maxBytes: number,
  where: string,
  product: string,
): Promise<string> {
  const tooLarge = () =>
    new BackendError(
      'bad_response',
      `${where}: ${product} の応答が大きすぎる（${formatMegabytes(maxBytes)} を超えた）。${product} の設定で、画像の大きさや枚数を確かめる`,
    );
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function formatMegabytes(bytes: number): string {
  return bytes >= MEGABYTE ? `${Math.round(bytes / MEGABYTE)} MB` : `${bytes} バイト`;
}

function parseBaseUrl(raw: string, product: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${product} の URL として読めない: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${product} の URL は http か https で始める: ${raw}`);
  }
  // 末尾の / を揃える: 無いと、相対パスの解決で最後のセグメント（/forge など）が落ちるため
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function classifyFetchError(
  error: unknown,
  context: {
    where: string;
    baseUrl: string;
    product: string;
    signal: AbortSignal | undefined;
    timeout: AbortSignal;
    timeoutMs: number;
  },
): BackendError {
  const { where, baseUrl, product, signal, timeout, timeoutMs } = context;
  if (signal?.aborted)
    return new BackendError('aborted', `${where}: 呼び手が止めた`, { cause: error });
  if (timeout.aborted) {
    return new BackendError(
      'timeout',
      `${where}: ${product} が ${timeoutMs}ms 待っても応答しない`,
      {
        cause: error,
      },
    );
  }
  const code = causeCode(error);
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return new BackendError(
      'unreachable',
      `${baseUrl} に繋がらない（${code}）。${product} が起動しているか、URL とポートが合っているかを確かめる`,
      { cause: error },
    );
  }
  // 原因の連鎖を最後までたどって書く: fetch は「fetch failed」とだけ言い、本当の理由（ポートが使えない・名前が引けない など）は cause の奥にあるため
  return new BackendError(
    'unreachable',
    `${baseUrl} に繋がらない（${causeMessages(error)}）。${product} が起動しているか、URL の書き方とポートが合っているかを確かめる（${where}）`,
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

function classifyStatus(
  status: number,
  body: string,
  where: string,
  baseUrl: string,
  product: string,
) {
  if (status === 401 || status === 403) {
    return new BackendError(
      'unauthorized',
      `${where}: 認証に失敗した（HTTP ${status}）。${product} の --api-auth と設定の認証情報を確かめる`,
    );
  }
  if (status === 404) {
    return new BackendError(
      'not_found',
      `${where}: API が無い（HTTP 404）。${baseUrl} が ${product} の URL か、${product} を --api 付きで起動しているかを確かめる`,
    );
  }
  return new BackendError(
    'failed',
    `${where}: ${product} が失敗を返した（HTTP ${status}）${detailOf(body)}`,
  );
}

// Forge・A1111（FastAPI）の失敗の応答は {detail} か {error, errors} の形で理由を返す
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
