// 台本の LLM（OpenAI 互換 /v1/chat/completions、ストリーム対応）。役は model 名で見分ける: talk-model / think-model / judge-model。
// 話す役は、ツールが渡されていて結果がまだ無ければ start_drawing を呼び、結果が来たら短く返す。
// toolCalling: json のときは tools を渡されず、response_format のスキーマ（reply か tool の union）で { kind: "tool", ... } を返す。
// holdTalk() で、次の話す役の呼び出し（ツールを渡すもの）を releaseTalk() まで止められる（ターンの途中を作る）。呼び出し側が切れたら待ちをやめる。
// ツールを渡さない呼び出し（ジョブが止まったことを伝えるターン）には TOOLLESS_REPLY を返す。
// queueTalkTool(name, input, times) で、次の times 回（既定 1）の話す役の呼び出しに、start_drawing の代わりにそのツールを呼ばせる（結果が来たあとは短く返す）。
// native では tools に、json では response_format のスキーマにそのツールがあるときに効く。
// 構造化出力は渡されたスキーマの必須項目を最小の値で埋める（スキーマが変わっても追従するため、固定の JSON を持たない）。
import { createServer } from 'node:http';
import { URL } from 'node:url';

/** ツールを渡さない話す役の呼び出しへの返答。描き始めの返答（「描き始めました。…」）と取り違えない文にする */
export const TOOLLESS_REPLY = '描き終わりました。いかがですか？';

/**
 * @param {any} schema
 * @param {string} [hint] プロパティ名
 * @returns {any}
 */
function generate(schema, hint = '') {
  if (schema === undefined || schema === true) return 'x';
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    return generate(
      alternatives.find((/** @type {any} */ s) => s.type !== 'null') ?? alternatives[0],
      hint,
    );
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0];
  switch (type) {
    case 'object': {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        if ((schema.required ?? []).includes(key)) out[key] = generate(value, key);
      }
      return out;
    }
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => generate(schema.items));
    case 'string':
      return hint === 'prompt' ? 'sunset beach, girl, 1girl' : 'x'.repeat(schema.minLength ?? 1);
    case 'integer':
    case 'number':
      return Math.max(
        schema.minimum ?? 0,
        schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0,
        Math.min(schema.maximum ?? 20, hint === 'steps' ? 8 : 7),
      );
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/**
 * @param {{ stopAfterIterations: number, rejectImages?: boolean, echoKey?: boolean }} options stopAfterIterations は見る役が何回目で止めてよいと言うか。
 *   rejectImages なら、画像を含む呼び出しを 400 で断る（画像を読めないモデルの代わり）。
 *   echoKey なら、どの呼び出しも 401 で断り、受け取った鍵（Authorization の値）を断りの本文に入れて返す（鍵を文に返すサーバの代わり）
 * @returns {Promise<{ url: string, close: () => Promise<void>, stats: { nativeTalkCalls: number, jsonTalkCalls: number, heldTalkCalls: number, abortedTalkCalls: number, toollessTalkCalls: number }, restartJudge: (stopAfter: number) => void, holdTalk: () => void, releaseTalk: () => void, queueTalkTool: (name: string, input: unknown, times?: number) => void }>}
 */
export async function startFakeLlm({ stopAfterIterations, rejectImages = false, echoKey = false }) {
  let judgeCalls = 0;
  let stopAfter = stopAfterIterations;
  // 話す役が、どの経路で呼ばれたか。native に倒れて通っただけ、を見分けるために数える
  const stats = {
    nativeTalkCalls: 0,
    jsonTalkCalls: 0,
    heldTalkCalls: 0,
    abortedTalkCalls: 0,
    toollessTalkCalls: 0,
  };
  let holdNext = false;
  /** @type {(() => void) | null} */
  let releaseHeld = null;
  /** @type {{ name: string, input: unknown, remaining: number } | null} */
  let queuedTool = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (!(req.method === 'POST' && path === '/v1/chat/completions')) {
        res.writeHead(404);
        return res.end('{}');
      }
      const request = JSON.parse(body);
      if (echoKey) {
        const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `invalid api key: ${key}` } }));
      }
      if (rejectImages && body.includes('"image_url"')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'image input is not supported' } }));
      }
      const role = String(request.model).replace('-model', '');
      // ジョブが止まったことを伝えるだけのターン（ツールを渡さない）。入力に入る止まりの一文で見分ける:
      // 「ツールが無い talk-model の呼び出し」で見分けると、doctor が talk-model で確かめる見る役の構造化出力まで拾うため
      const toolless =
        role === 'talk' &&
        !(Array.isArray(request.tools) && request.tools.length > 0) &&
        JSON.stringify(request.messages).includes('会話のジョブが止まった');
      // holdTalk は、ツールを渡す呼び出し（人間の発言を読むターン）だけを止める: ジョブの止まりで起きたターンに、
      // 確かめが止めたい呼び出しの待ちを横取りさせないため
      if (role === 'talk' && holdNext && !toolless) {
        holdNext = false;
        stats.heldTalkCalls++;
        await new Promise((resolve) => {
          releaseHeld = () => resolve(undefined);
          res.on('close', () => resolve(undefined));
        });
        releaseHeld = null;
        if (res.destroyed) {
          stats.abortedTalkCalls++;
          return;
        }
      }
      const hasToolResult =
        request.messages.some((/** @type {{ role: string }} */ m) => m.role === 'tool') ||
        ['で描き始めた', 'をお気に入りにして採った'].some((done) =>
          JSON.stringify(request.messages).includes(done),
        );
      const format = request.response_format;
      // 待ちが解けたあとに取る: 待っている間に台本を差し替えられるように
      const talkSchema = format?.json_schema?.schema ?? format?.schema;
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      const queued =
        role === 'talk' &&
        queuedTool !== null &&
        (hasTools || JSON.stringify(talkSchema ?? {}).includes(`"${queuedTool.name}"`))
          ? queuedTool
          : null;
      if (queued !== null) {
        queued.remaining -= 1;
        if (queued.remaining <= 0) queuedTool = null;
      }
      const toolName = queued?.name ?? 'start_drawing';
      const toolArgs = JSON.stringify(
        queued?.input ?? {
          request: '夕焼けの海辺の少女',
          stopConditions: { aiJudgement: true, maxIterations: stopAfter },
        },
      );
      /** @type {'tool' | 'text' | 'json'} */
      let kind;
      let content = '';
      const isJsonTalk =
        role === 'talk' &&
        !hasTools &&
        (queued !== null || JSON.stringify(talkSchema ?? {}).includes('"start_drawing"'));
      if (toolless) {
        stats.toollessTalkCalls++;
        kind = talkSchema === undefined ? 'text' : 'json';
        content =
          talkSchema === undefined
            ? TOOLLESS_REPLY
            : JSON.stringify({ kind: 'reply', text: TOOLLESS_REPLY });
      } else if (isJsonTalk) {
        stats.jsonTalkCalls++;
        kind = 'json';
        content = JSON.stringify(
          hasToolResult
            ? { kind: 'reply', text: '描き始めました。少しお待ちください。' }
            : { kind: 'tool', name: toolName, input: JSON.parse(toolArgs) },
        );
      } else if (role === 'talk' && Array.isArray(request.tools) && request.tools.length > 0) {
        stats.nativeTalkCalls++;
        if (hasToolResult && queued === null) {
          kind = 'text';
          content = '描き始めました。少しお待ちください。';
        } else {
          kind = 'tool';
        }
      } else {
        kind = 'json';
        const schema = format?.json_schema?.schema ?? format?.schema;
        let out = generate(schema);
        if (schema?.properties?.canStop) {
          const n = judgeCalls++;
          const last = n + 1 >= stopAfter;
          const count = schema.properties.images?.minItems ?? 1;
          out = {
            images: Array.from({ length: count }, () => ({
              score: last ? 0.92 : 0.35,
              issues: last ? [] : ['海の色が暗い'],
            })),
            nextChange: last ? '' : '夕焼けの赤を強める',
            canStop: last,
          };
        }
        if (schema?.properties?.params) {
          out.params = { ...out.params, prompt: 'sunset beach, 1girl, orange sky' };
        }
        content = JSON.stringify(out);
      }
      const base = {
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: request.model,
      };
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        /** @param {unknown} o */
        const write = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        /** @param {object} delta @param {string | null} [finish] */
        const choice = (delta, finish = null) => ({
          ...base,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        write(choice({ role: 'assistant', content: '' }));
        if (kind === 'tool') {
          write(
            choice({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: toolName, arguments: '' },
                },
              ],
            }),
          );
          write(choice({ tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }));
          write(choice({}, 'tool_calls'));
        } else {
          for (let i = 0; i < content.length; i += 12)
            write(choice({ content: content.slice(i, i + 12) }));
          write(choice({}, 'stop'));
        }
        write({ ...base, choices: [], usage });
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        const message =
          kind === 'tool'
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: toolName, arguments: toolArgs },
                  },
                ],
              }
            : { role: 'assistant', content };
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            created: 0,
            model: request.model,
            choices: [
              { index: 0, message, finish_reason: kind === 'tool' ? 'tool_calls' : 'stop' },
            ],
            usage,
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('偽の LLM のポートを取れなかった');
  return {
    stats,
    holdTalk: () => {
      holdNext = true;
    },
    releaseTalk: () => releaseHeld?.(),
    queueTalkTool: (
      /** @type {string} */ name,
      /** @type {unknown} */ input,
      /** @type {number} */ times = 1,
    ) => {
      queuedTool = { name, input, remaining: times };
    },
    restartJudge: (/** @type {number} */ next) => {
      judgeCalls = 0;
      stopAfter = next;
    },
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
