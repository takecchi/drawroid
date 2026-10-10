import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DoctorReport } from '@drawroid/api';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { backendFactory } from './backend-factory.js';
import { backendOptions, createBackendSettings } from './backend-settings.js';
import { formatDoctorReport, runDoctor, screenDoctor, type DoctorOptions } from './doctor.js';
import { ReplaceableBackend } from './replaceable-backend.js';
import { createApp } from './server.js';
import { stubDeps } from './test-support.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** 決まった口だけに答える、小さな偽のバックエンド。ほかの口は 404 */
async function startBackend(routes: Record<string, unknown>): Promise<string> {
  const server = createServer((req, res) => {
    const body = routes[`${req.method} ${req.url}`];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { detail: 'Not Found' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * 小さな偽の LLM（OpenAI 互換、ストリーム）。ツールを渡されたら doctor_ping を呼び、そうでなければ確かめの JSON を返す。
 * 渡された画像の形式と中身を取っておき、rejectWebp なら webp の画像を llama.cpp と同じ文言の 400 で断る。
 * rejectImages なら、画像を読めないモデル（mmproj の無い llama.cpp）と同じ文言の 400 で、どの画像も断る。
 * talkReply を渡したら、話す役の確かめ（doctor_ping を名指す要求）には、ツールを呼ばずにその本文を返す。
 * thinkReply を渡したら、考える役の確かめ（ok を求める要求）には、その本文を返す
 */
async function startLlm({
  rejectWebp,
  rejectImages = false,
  talkReply,
  thinkReply,
}: {
  rejectWebp: boolean;
  rejectImages?: boolean;
  talkReply?: string;
  thinkReply?: string;
}) {
  const imageTypes: string[] = [];
  const images: Buffer[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const request = JSON.parse(body) as {
        tools?: unknown[];
        response_format?: { json_schema?: { schema?: unknown } };
      };
      imageTypes.push(...[...body.matchAll(/data:(image\/[a-z]+);base64/g)].map((m) => m[1]!));
      images.push(
        ...[...body.matchAll(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/g)].map((m) =>
          Buffer.from(m[1]!, 'base64'),
        ),
      );
      if (rejectWebp && body.includes('data:image/webp')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Failed to load image or audio file' } }));
        return;
      }
      if (rejectImages && body.includes('data:image/')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
            },
          }),
        );
        return;
      }
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (talkReply !== undefined && body.includes('doctor_ping')) {
        res.write(chunk({ role: 'assistant', content: talkReply }));
        res.write(chunk({}, 'stop'));
      } else if ((request.tools ?? []).length > 0) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'doctor_ping', arguments: '{}' },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        const schema = JSON.stringify(request.response_format ?? {});
        const content =
          thinkReply !== undefined && body.includes('ok に true')
            ? thinkReply
            : schema.includes('"color"')
              ? '{"color":"red"}'
              : '{"ok":true}';
        res.write(chunk({ role: 'assistant', content }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    imageTypes,
    images,
  };
}

const SDAPI_BASE = {
  'GET /sdapi/v1/cmd-flags': {},
  'GET /sdapi/v1/scripts': { txt2img: [], img2img: [] },
  'GET /sdapi/v1/sd-models': [],
  'GET /sdapi/v1/samplers': [],
};

/**
 * 繋がらない所として、いま何も待ち受けていないポートを渡す。既定の 7860 は使わない: 手元で Forge が 7860 にいると繋がってしまうため。
 * :9 も使わない: fetch が繋ぐ前に断るポート（bad port）で、本番の「繋がらない」と文が違う
 */
async function closedUrl() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return { url: `http://127.0.0.1:${port}`, port };
}

async function setup(config: unknown, overrides: Partial<DoctorOptions> = {}) {
  const { url } = await closedUrl();
  const dir = await mkdtemp(join(tmpdir(), 'drawroid-doctor-'));
  const configPath = join(dir, 'config.json');
  if (config !== undefined) {
    await writeFile(configPath, typeof config === 'string' ? config : JSON.stringify(config));
  }
  const webRoot = join(dir, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html>');
  const report = await runDoctor({
    configPath,
    backendKind: undefined,
    backendUrl: url,
    caller: 'cli',
    env: {},
    webRoot: () => webRoot,
    backendTimeoutMs: 2_000,
    llmTimeoutMs: 2_000,
    ...overrides,
  });
  return { report, text: formatDoctorReport(report), url };
}

describe('runDoctor', () => {
  it('reports a missing config as fine, and the missing LLM as lacking with what to do', async () => {
    const { report, text } = await setup(undefined);
    expect(text).toContain('よい      まだ無い');
    expect(text).toMatch(/足りない {2}まだ設定していない\n {12}→ .*\/settings#llm/);
    expect(text).toContain('よい      ある（');
    expect(report.lacking).toBeGreaterThan(0);
    expect(text).toContain(`足りないものが ${report.lacking} つある`);
  });

  it('names the broken JSON', async () => {
    const { text } = await setup('{"llm": ');
    expect(text).toContain('足りない  JSON として読めない');
    expect(text).toContain('config.json の llm が読めないので確かめられない');
  });

  it('names each broken field of config.json', async () => {
    const { text } = await setup({
      backend: { url: 'not a url' },
      llm: { providers: {}, roles: { think: { provider: 'local' } } },
      budgets: { text: { prompt: -1 } },
      permissions: { steps: { mode: 'sometimes' } },
      generationProgress: { includePreview: 'yes' },
      conversations: { defaultStopConditions: {} },
    });
    for (const field of [
      'backend.url',
      'llm.roles.think',
      'budgets.text.prompt',
      'permissions.steps',
      'generationProgress.',
      'conversations.defaultStopConditions',
    ]) {
      expect(text).toMatch(new RegExp(`足りない {2}${field.replaceAll('.', '\\.')}`));
    }
  });

  it('shows only the name of the API key variable and whether it is set', async () => {
    const llm = {
      providers: {
        set: { type: 'openai', apiKeyEnv: 'DOCTOR_SET_KEY' },
        unset: { type: 'anthropic', apiKeyEnv: 'DOCTOR_UNSET_KEY' },
      },
      roles: { think: { provider: 'set', model: 'gpt' } },
    };
    const secret = 'sk-never-shown-1234';
    const { text } = await setup(
      { llm },
      {
        env: { DOCTOR_SET_KEY: secret },
        // LLM は誰も待ち受けていない所を指す: 往復は失敗するが、鍵の扱いだけを見る
      },
    );
    expect(text).toContain('API キーの環境変数 DOCTOR_SET_KEY は入っている');
    expect(text).toMatch(
      /足りない {2}provider unset（anthropic）: API キーの環境変数 DOCTOR_UNSET_KEY が入っていない\n {12}→ DOCTOR_UNSET_KEY に API キーを入れた端末から/,
    );
    expect(text).not.toContain(secret);
  });

  it('checks the thinking role together with the judge when they share a provider and model, and never with the talking role', async () => {
    const { url } = await closedUrl();
    const providers = {
      a: { type: 'openai-compatible', baseURL: `${url}/v1` },
      b: { type: 'openai-compatible', baseURL: `${url}/v1` },
    };
    // 考える役と見る役が同じ割り当てで、話す役だけが別
    const shared = await setup({
      llm: {
        providers,
        // 繋がらない所へ再試行を重ねない: 確かめの数と並びだけを見る
        networkRetries: 0,
        roles: {
          think: { provider: 'a', model: 'm1' },
          talk: { provider: 'a', model: 'm2' },
        },
      },
    });
    const sharedTrips = shared.text.split('\n').filter((line) => line.includes('1往復'));
    expect(sharedTrips).toHaveLength(2);
    expect(sharedTrips[0]).toContain('話す役（a の m2');
    expect(sharedTrips[1]).toContain('考える役・見る役（a の m1');

    // 同じモデルの名前でも、サーバ（provider）が違えば別の割り当て
    const servers = await setup({
      llm: {
        providers,
        // 繋がらない所へ再試行を重ねない: 確かめの数と並びだけを見る
        networkRetries: 0,
        roles: {
          think: { provider: 'a', model: 'm' },
          judge: { provider: 'b', model: 'm' },
          talk: { provider: 'a', model: 'm' },
        },
      },
    });
    const serverTrips = servers.text.split('\n').filter((line) => line.includes('1往復'));
    expect(serverTrips).toHaveLength(3);
    expect(serverTrips[0]).toContain('話す役（a の m');
    expect(serverTrips[1]).toContain('考える役（a の m');
    expect(serverTrips[2]).toContain('見る役（b の m');
  });

  // 考える役の確かめ（{"ok": true}）には、実機（Qwen2.5-VL-3B・1.5B）は30回とも正しく答えた。崩れた本文として、
  // 同じ実機の Qwen2.5-1.5B が doctor の話す役の確かめに返したもの（ok の欄が無い）を流す
  it('checks the structured output of the thinking role even when it shares the model of the talking role', async () => {
    const llm = await startLlm({
      rejectWebp: false,
      thinkReply: '{"kind":"reply","text":"pong"}',
    });
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
        validationRetries: 0,
        roles: {
          // 話す役は考える役の割り当てを使う。見る役は同じモデルでも、構造化出力の出し方が違う
          think: { provider: 'a', model: 'm', structuredOutput: 'text' },
          judge: { provider: 'a', model: 'm', structuredOutput: 'native' },
        },
      },
    });

    expect(text).toMatch(/よい +話す役（a の m、/);
    expect(text).toMatch(
      /足りない +考える役（a の m、structuredOutput: text、.*スキーマに合わなかった/,
    );
    expect(text).toMatch(/よい +見る役（a の m、structuredOutput: native、/);
  });

  // 返す本文は、実機の llama.cpp（Qwen2.5-VL-3B・Qwen2.5-1.5B）が doctor の確かめに返したもの
  describe('when the talking role does not call the tool', () => {
    async function talkItem(
      role: { toolCalling: string; structuredOutput: string },
      talkReply: string,
    ) {
      const llm = await startLlm({ rejectWebp: false, talkReply });
      const { report } = await setup({
        llm: {
          providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
          validationRetries: 0,
          roles: { think: { provider: 'a', model: 'm', ...role } },
        },
      });
      const item = report.sections
        .find(({ title }) => title === 'LLM')
        ?.items.find(({ what }) => what.includes('話す役'));
      expect(item?.ok).toBe(false);
      return item!;
    }

    it('says the reply was empty, rather than quoting an empty reply', async () => {
      const item = await talkItem({ toolCalling: 'native', structuredOutput: 'native' }, '');

      expect(item.what).toContain('文も返さなかった');
      expect(item.what).not.toContain('「」');
      expect(item.todo).toContain('toolCalling を json にする');
    });

    it('quotes the reply, and points native tool calling to json', async () => {
      const item = await talkItem(
        { toolCalling: 'native', structuredOutput: 'native' },
        'doctor_ping',
      );

      expect(item.what).toContain('ツールを呼ばずに文で返した: 「doctor_ping」');
      expect(item.todo).toContain('toolCalling を json にする');
      expect(item.todo).not.toContain('structuredOutput');
    });

    it.each([
      ['the name of the tool', '{"kind":"reply","text":"doctor_ping"}'],
      ['a word of its own', '{"kind":"reply","text":"pong"}'],
    ])(
      'points json tool calling with native structured output to json structured output, when it replies with %s',
      async (_, talkReply) => {
        const item = await talkItem({ toolCalling: 'json', structuredOutput: 'native' }, talkReply);

        expect(item.todo).toContain('structuredOutput を json にする');
        expect(item.todo).not.toContain('指示に従えるモデル');
      },
    );

    it.each(['json', 'text'])(
      'points json tool calling with %s structured output to another model',
      async (structuredOutput) => {
        const item = await talkItem(
          { toolCalling: 'json', structuredOutput },
          '{"kind":"reply","text":"pong"}',
        );

        expect(item.todo).toContain('指示に従えるモデルに変える');
        expect(item.todo).not.toContain('structuredOutput を json');
      },
    );
  });

  it('flags a judge model that is set not to read images, without calling it', async () => {
    const { url } = await closedUrl();
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: `${url}/v1` } },
        roles: {
          think: { provider: 'a', model: 'm1' },
          judge: { provider: 'a', model: 'm2', imageInput: false },
        },
      },
    });
    expect(text).toMatch(
      /足りない {2}見る役（a の m2、.*imageInput: false.*\n {12}→ 見る役に画像を読めるモデルを割り当て/,
    );
  });

  // 見る役に渡る画像は、storage-fs が作る縮小版（webp）を、LLM に送るときに JPEG にしたもの。
  // 確かめで別の形式を渡すと、ジョブの見る役が読めるかどうかと、確かめの結果が食い違う
  it('shows the judge an image in the same format the job loop sends', async () => {
    const llm = await startLlm({ rejectWebp: true });
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
        roles: {
          think: { provider: 'a', model: 'm1' },
          judge: { provider: 'a', model: 'm2' },
          talk: { provider: 'a', model: 'm1' },
        },
      },
    });
    expect(llm.imageTypes).toEqual(['image/jpeg']);
    expect(text).toMatch(/よい +見る役（a の m2、.*画像を1枚渡して1往復できた/);
  });

  it('names the format it sent when the judge cannot read the image', async () => {
    const llm = await startLlm({ rejectWebp: false, rejectImages: true });
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
        roles: {
          think: { provider: 'a', model: 'm1' },
          judge: { provider: 'a', model: 'm2' },
          talk: { provider: 'a', model: 'm1' },
        },
      },
    });
    expect(text).toMatch(
      /足りない {2}見る役（a の m2、.*画像（image\/jpeg。ジョブが見る役に渡すのと同じ形式）を渡すと返事が来ない/,
    );
  });

  // 本番と同じ大きさで確かめる: 見る役に渡る縮小版の長辺は、設定した予算（budgets.imageLongEdge）で決まる。
  // 読めない値なら、起動と同じく既定（512）で動く。ほかの欄だけが読めないときは、読めた長辺をそのまま使う（起動と同じ）
  it.each([
    ['no budget', undefined, 512],
    ['a long edge of 256', { imageLongEdge: 256 }, 256],
    ['a long edge of 1024', { imageLongEdge: 1024 }, 1024],
    ['an unreadable long edge', { imageLongEdge: 5 }, 512],
    ['a long edge written as a string', { imageLongEdge: '256' }, 512],
    ['a negative long edge', { imageLongEdge: -256 }, 512],
    ['a long edge of 0', { imageLongEdge: 0 }, 512],
    ['a null long edge', { imageLongEdge: null }, 512],
    ['a fractional long edge', { imageLongEdge: 256.5 }, 512],
    ['a huge long edge', { imageLongEdge: 1e9 }, 512],
    [
      'a long edge of 256 next to an unreadable field',
      { imageLongEdge: 256, text: { prompt: -1 } },
      256,
    ],
  ])('shows the judge an image as large as the budget says, with %s', async (_, budgets, edge) => {
    const llm = await startLlm({ rejectWebp: false });
    await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
        roles: { think: { provider: 'a', model: 'm' } },
      },
      ...(budgets !== undefined && { budgets }),
    });

    expect(llm.images).toHaveLength(1);
    const { width, height } = await sharp(llm.images[0]).metadata();
    expect(Math.max(width ?? 0, height ?? 0)).toBe(edge);
  });

  // 話す役の確かめはツールを1つ呼ばせるだけで、画像を渡さない。割り当てが同じでも、見る役が画像を読めるかは別に確かめる
  it('checks the judge with an image even when it shares the talk assignment', async () => {
    const llm = await startLlm({ rejectWebp: false });
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
        roles: { think: { provider: 'a', model: 'm' } },
      },
    });
    const trips = text.split('\n').filter((line) => line.includes('1往復'));
    // 全部の役が同じモデルでも、考える役は構造化出力で確かめる（見る役と出し方が同じなので、見る役の確かめに含める）
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatch(/よい +話す役（a の m、.*1往復できた/);
    expect(trips[1]).toMatch(/よい +考える役・見る役（a の m、.*画像を1枚渡して1往復できた/);
  });

  it('passes the image only to the judge, and lists the roles as talk, think, judge', async () => {
    const llm = await startLlm({ rejectWebp: false, rejectImages: true });
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: llm.url } },
        roles: {
          think: { provider: 'a', model: 'think-model' },
          judge: { provider: 'a', model: 'judge-model' },
          talk: { provider: 'a', model: 'talk-model' },
        },
      },
    });
    const roleLines = text
      .split('\n')
      .filter((line) => /^ {2}\S+ +(話す役|考える役|見る役)（/.test(line));
    expect(roleLines.map((line) => /(話す役|考える役|見る役)（/.exec(line)?.[1])).toEqual([
      '話す役',
      '考える役',
      '見る役',
    ]);
    // 考える役には画像を渡さないので、画像を読めないサーバでも通る
    expect(roleLines[1]).toMatch(/^ {2}よい +考える役（a の think-model、.*と1往復できた/);
    // 見る役には画像を渡すので断られ、画像なしなら通ることから、画像が原因と名指す
    expect(roleLines[2]).toMatch(
      /^ {2}足りない +見る役（a の judge-model、.*画像を読めない可能性がある/,
    );
  });

  it('says which product is running when it differs from the configured kind', async () => {
    // Forge にだけある口（sd-modules）に答えるので、Forge が動いていると見なす
    const url = await startBackend({
      ...SDAPI_BASE,
      'GET /sdapi/v1/sd-modules': [],
      'GET /internal/sysinfo': { Version: 'f2.0.1v1.10.1' },
    });
    const { text } = await setup(undefined, { backendKind: 'a1111', backendUrl: url });
    expect(text).toContain(
      '足りない  Forge が動いている（版 f2.0.1v1.10.1）が、A1111 として繋ごうとしている',
    );
    expect(text).toContain('→ --backend forge を付けて起動するか');
    expect(text).toMatch(
      /足りない {2}チェックポイントが1つも無い\n {12}→ .*models\/Stable-diffusion/,
    );
  });

  it('flags an A1111 older than the supported version, and treats a missing ControlNet as fine', async () => {
    const url = await startBackend({
      ...SDAPI_BASE,
      'GET /sdapi/v1/sd-models': [
        { title: 'a.safetensors [abc]', model_name: 'a', filename: '/m/a.safetensors' },
      ],
      'GET /internal/sysinfo': { Version: 'v1.8.0' },
    });
    const { text } = await setup(undefined, { backendKind: 'a1111', backendUrl: url });
    expect(text).toContain('足りない  A1111 の版 v1.8.0は古い');
    expect(text).toContain('よい      ControlNet は使えない（使わないなら、このままでよい）');
  });

  it('tells to give doctor the same --backend-url only when it could not reach the default URL', async () => {
    const hint = 'drawroid doctor にも同じ --backend-url を付ける';
    // 何も指定しない doctor は既定の URL を見る。起動にだけ付けた --backend-url は見えない
    // 既定の 7860 の代わりに、何も待ち受けていないポートを既定として渡す（closedUrl）
    const byDefault = await setup(undefined, { backendUrlSource: 'default' });
    expect(byDefault.text).toContain(`足りない  繋がらない: ${byDefault.url}（既定）`);
    expect(byDefault.text).toContain(hint);

    // URL を指定したうえで繋がらないなら、その URL を直す話で、doctor の引数の話ではない
    const byFlag = await setup(undefined, { backendUrlSource: 'cli' });
    expect(byFlag.text).toContain(`足りない  繋がらない: ${byFlag.url}（--backend-url で指定）`);
    expect(byFlag.text).not.toContain(hint);
  });

  it('does not tell to give doctor --backend-url when the URL came from config.json or from doctor own --backend-url', async () => {
    const hint = 'drawroid doctor にも同じ --backend-url を付ける';
    // drawroid doctor の入り方: 引数に URL が無ければ undefined を渡し、config.json の backend.url から決める
    const { url } = await closedUrl();
    const byConfig = await setup({ backend: { url } }, { backendUrl: undefined });
    expect(byConfig.text).toContain(`足りない  繋がらない: ${url}（config.json の backend.url）`);
    expect(byConfig.text).not.toContain(hint);

    // doctor に --backend-url を付けたときは、backendUrlSource を渡さずに URL だけを渡す
    const byOwnFlag = await setup(undefined);
    expect(byOwnFlag.text).toContain(
      `足りない  繋がらない: ${byOwnFlag.url}（--backend-url で指定）`,
    );
    expect(byOwnFlag.text).not.toContain(hint);
  });

  it('reports a missing web build as lacking', async () => {
    const { text } = await setup(undefined, { webRoot: () => '/nonexistent/web' });
    expect(text).toMatch(/足りない {2}\/nonexistent\/web に index\.html が無い\n {12}→ /);
  });
});

// 起動（index.ts）と同じ組み立てで、画面が叩く POST /api/doctor を通す
describe('the check from the settings screen', () => {
  const webRoot = fileURLToPath(new URL('./test-fixtures/web', import.meta.url));

  async function checkFromScreen(initial: { url: string; source: 'cli' | 'config' | 'default' }) {
    const dir = await mkdtemp(join(tmpdir(), 'drawroid-doctor-screen-'));
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, '{}');
    const createBackend = backendFactory('forge');
    const backendSettings = createBackendSettings({
      configPath,
      backend: new ReplaceableBackend(createBackend(backendOptions(initial.url, undefined))),
      createBackend,
      initial: { kind: 'forge', ...initial, config: {} },
    });
    const doctor = screenDoctor({ configPath, backendSettings, env: {}, webRoot: () => webRoot });
    const app = createApp({ webRoot, deps: { ...stubDeps(), doctor } });
    const res = await app.request('/api/doctor', { method: 'POST' });
    expect(res.status).toBe(200);
    return { body: (await res.json()) as { report: DoctorReport }, dir };
  }

  it('does not tell the screen to give doctor --backend-url, even when it could not reach the default URL', async () => {
    const { url } = await closedUrl();
    const { body } = await checkFromScreen({ url, source: 'default' });
    const backend = body.report.sections.find(({ title }) =>
      title.startsWith('画像のバックエンド'),
    );
    expect(backend?.items[0]?.what).toContain(`繋がらない: ${url}（既定）`);
    expect(backend?.items[0]?.todo).toContain('--api を付けて起動する');
    expect(backend?.items[0]?.todo).not.toContain(
      'drawroid doctor にも同じ --backend-url を付ける',
    );
  });

  // 画面の試験（apps/web の doctor-check）に流す記録。手で組み立てず、ここで取った応答を置く。
  // 本番の文が変わるとこの試験が落ちるので、`vitest -u` で取り直す。パスとポートは回すたびに違うので、
  // パスは名前に、ポートは本番の既定（7860）に置き換える
  it('records what the screen receives, for the screen tests', async () => {
    const { url, port } = await closedUrl();
    const { body, dir } = await checkFromScreen({ url, source: 'default' });
    const recorded = JSON.stringify(body, null, 2)
      .replaceAll(dir, '<データディレクトリ>')
      .replaceAll(webRoot, '<web の配り先>')
      .replaceAll(`127.0.0.1:${port}`, '127.0.0.1:7860');
    await expect(`${recorded}\n`).toMatchFileSnapshot(
      '../../web/app/test-support/fixtures/doctor.json',
    );
  });
});
