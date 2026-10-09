import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { formatDoctorReport, runDoctor, type DoctorOptions } from './doctor.js';

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
 * 渡された画像の形式と中身を取っておき、rejectWebp なら webp の画像を llama.cpp と同じ文言の 400 で断る
 */
async function startLlm({ rejectWebp }: { rejectWebp: boolean }) {
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
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ((request.tools ?? []).length > 0) {
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
        const content = schema.includes('"color"') ? '{"color":"red"}' : '{"ok":true}';
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

async function setup(config: unknown, overrides: Partial<DoctorOptions> = {}) {
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
    backendUrl: 'http://127.0.0.1:9',
    env: {},
    webRoot: () => webRoot,
    backendTimeoutMs: 2_000,
    llmTimeoutMs: 2_000,
    ...overrides,
  });
  return { report, text: formatDoctorReport(report) };
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

  it('checks each distinct assignment once: roles sharing a provider and model are checked together', async () => {
    const providers = {
      a: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' },
      b: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' },
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
    expect(serverTrips).toHaveLength(2);
    expect(serverTrips[0]).toContain('話す役・考える役（a の m');
    expect(serverTrips[1]).toContain('見る役（b の m');
  });

  it('flags a judge model that is set not to read images, without calling it', async () => {
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' } },
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

  // 見る役に渡る画像は、storage-fs が作る縮小版（webp）。確かめに別の形式（png）を渡すと、
  // webp を読めないサーバ（llama.cpp）でも「1往復できた」と出て、ジョブを走らせてから見る役で落ちる
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
    expect(llm.imageTypes[0]).toBe('image/webp');
    expect(text).toMatch(
      /足りない {2}見る役（a の m2、.*画像（image\/webp。ジョブが見る役に渡すのと同じ形式）を渡すと返事が来ない/,
    );
  });

  // 本番と同じ大きさで確かめる: 見る役に渡る縮小版の長辺は、設定した予算（budgets.imageLongEdge）で決まる。
  // 読めない値なら、起動と同じく既定（512）で動く
  it.each([
    ['no budget', undefined, 512],
    ['a long edge of 256', { imageLongEdge: 256 }, 256],
    ['a long edge of 1024', { imageLongEdge: 1024 }, 1024],
    ['an unreadable long edge', { imageLongEdge: 5 }, 512],
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
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatch(/よい +話す役・考える役（a の m、.*1往復できた/);
    expect(trips[1]).toMatch(/よい +見る役（a の m、.*画像を1枚渡して1往復できた/);
  });

  it('passes the image only to the judge, and lists the roles as talk, think, judge', async () => {
    const llm = await startLlm({ rejectWebp: true });
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

  it('reports a missing web build as lacking', async () => {
    const { text } = await setup(undefined, { webRoot: () => '/nonexistent/web' });
    expect(text).toMatch(/足りない {2}\/nonexistent\/web に index\.html が無い\n {12}→ /);
  });
});
