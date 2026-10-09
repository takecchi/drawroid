import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * 構造化出力にだけ答える、小さな偽の LLM（OpenAI 互換）。画像を含む呼び出しは 400 で断る（画像を読めないモデルの代わり）。
 * 見る役の型（color）を求められたら color を、ほかは ok を返す。ツールを渡す呼び出し（話す役）にも同じ文で答える
 */
async function startImageBlindLlm(): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (body.includes('"image_url"')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'image input is not supported' } }));
        return;
      }
      const request = JSON.parse(body) as { model: string; stream?: boolean };
      const content = JSON.stringify(body.includes('"color"') ? { color: 'red' } : { ok: true });
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (request.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = {
          id: 'fake',
          object: 'chat.completion.chunk',
          created: 0,
          model: request.model,
        };
        for (const [delta, finish] of [
          [{ role: 'assistant', content }, null],
          [{}, 'stop'],
        ] as const) {
          res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        }
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake',
          object: 'chat.completion',
          created: 0,
          model: request.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage,
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
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

  it('passes the image only to the judge, and lists the roles as talk, think, judge', async () => {
    const baseURL = await startImageBlindLlm();
    const { text } = await setup({
      llm: {
        providers: { a: { type: 'openai-compatible', baseURL } },
        networkRetries: 0,
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
    // 考える役には画像を渡さないので、画像を読めないモデルでも通る
    expect(roleLines[1]).toMatch(/^ {2}よい +考える役（a の think-model、.*と1往復できた/);
    // 見る役には画像を渡すので断られ、画像なしなら通ることから、画像が原因と名指す
    expect(roleLines[2]).toMatch(
      /^ {2}足りない +見る役（a の judge-model、.*このモデルは画像を読めない可能性がある/,
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
