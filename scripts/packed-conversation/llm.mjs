// 台本の LLM（OpenAI 互換 /v1/chat/completions、ストリーム対応）。役は model 名で見分ける: talk-model / think-model / judge-model。
// 話す役は、ツールが渡されていて結果がまだ無ければ start_drawing を呼び、結果が来たら短く返す。
// toolCalling: json のときは tools を渡されず、response_format のスキーマ（reply か tool の union）で { kind: "tool", ... } を返す。
// 構造化出力は渡されたスキーマの必須項目を最小の値で埋める（スキーマが変わっても追従するため、固定の JSON を持たない）。
import { createServer } from 'node:http';
import { URL } from 'node:url';

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
 * @param {{ stopAfterIterations: number }} options 見る役が何回目で止めてよいと言うか
 * @returns {Promise<{ url: string, close: () => Promise<void>, stats: { nativeTalkCalls: number, jsonTalkCalls: number }, restartJudge: (stopAfter: number) => void }>}
 */
export async function startFakeLlm({ stopAfterIterations }) {
  let judgeCalls = 0;
  let stopAfter = stopAfterIterations;
  // 話す役が、どの経路で呼ばれたか。native に倒れて通っただけ、を見分けるために数える
  const stats = { nativeTalkCalls: 0, jsonTalkCalls: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (!(req.method === 'POST' && path === '/v1/chat/completions')) {
        res.writeHead(404);
        return res.end('{}');
      }
      const request = JSON.parse(body);
      const role = String(request.model).replace('-model', '');
      const hasToolResult =
        request.messages.some((/** @type {{ role: string }} */ m) => m.role === 'tool') ||
        JSON.stringify(request.messages).includes('で描き始めた');
      const format = request.response_format;
      const toolArgs = JSON.stringify({
        request: '夕焼けの海辺の少女',
        stopConditions: { aiJudgement: true, maxIterations: stopAfter },
      });
      /** @type {'tool' | 'text' | 'json'} */
      let kind;
      let content = '';
      const talkSchema = format?.json_schema?.schema ?? format?.schema;
      const isJsonTalk =
        role === 'talk' &&
        !(Array.isArray(request.tools) && request.tools.length > 0) &&
        JSON.stringify(talkSchema ?? {}).includes('"start_drawing"');
      if (isJsonTalk) {
        stats.jsonTalkCalls++;
        kind = 'json';
        content = JSON.stringify(
          hasToolResult
            ? { kind: 'reply', text: '描き始めました。少しお待ちください。' }
            : { kind: 'tool', name: 'start_drawing', input: JSON.parse(toolArgs) },
        );
      } else if (role === 'talk' && Array.isArray(request.tools) && request.tools.length > 0) {
        stats.nativeTalkCalls++;
        if (hasToolResult) {
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
                  function: { name: 'start_drawing', arguments: '' },
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
                    function: { name: 'start_drawing', arguments: toolArgs },
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
