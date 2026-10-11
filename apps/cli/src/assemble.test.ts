// drawroid の組み立て（assembleDrawroid）を、本物のファイルの置き場所で起動して見る試験。
// 組み立ての順（話す役を立ててからジョブを再開する・落ちる前の止まりで話しかけ直さない）と、止める合図のつなぎは、
// 部品の試験からは見えないため、組み立てそのものを呼ぶ
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobRunner } from '@drawroid/core';
import {
  FsConversationStore,
  FsJobStore,
  initDataDir,
  writeLlmSettings,
} from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assembleDrawroid } from './assemble.js';
import type { Listening } from './listen.js';

/** 話しかけないことを見るときに、何も起きないのを待つ長さ */
const QUIET_MS = 500;

let root: string;
let webRoot: string;
let running: Listening | undefined;

beforeEach(async () => {
  const work = await mkdtemp(join(tmpdir(), 'drawroid-assemble-'));
  root = join(work, 'data');
  webRoot = join(work, 'web');
  await mkdir(webRoot);
  await initDataDir(root);
});
afterEach(async () => {
  await new Promise((resolve) => (running ? running.server.close(resolve) : resolve(undefined)));
  running = undefined;
  // 繰り返す: 組み立ては止める口を持たず、止まったジョブの蒸留などが片付けの最中にも書き込んで、rmdir が ENOTEMPTY で落ちることがあるため
  await rm(join(root, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function start(
  signals = new EventEmitter(),
  exit = vi.fn(),
  write: (text: string) => void = () => undefined,
  // 既定は繋がらないバックエンド: 生成を見る試験だけが偽の Forge を渡す
  backendUrl = 'http://127.0.0.1:9',
) {
  return assembleDrawroid({
    root,
    args: { port: 0, backend: undefined, backendUrl },
    env: {},
    signals,
    exit,
    write,
    webRoot,
  }).then((listening) => (running = listening));
}

/** 会話に属する、AI の判断で止まったジョブ（落ちる前に止まった）を置く */
async function stoppedJobOf(conversationId: string) {
  const spec = await new FsJobStore(root).createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: true, maxIterations: 5 },
      batchSize: 1,
      conversationId,
      turn: 1,
    },
    {
      status: 'stopped',
      carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 1 },
      stoppedAt: new Date().toISOString(),
      imagesGenerated: 1,
      reason: { kind: 'ai', detail: '見る役が意図どおりと判断した' },
    },
    new Date(),
  );
  return spec.jobId;
}

const turnsStarted = async (conversations: FsConversationStore, conversationId: string) =>
  (await conversations.readEvents(conversationId)).events.filter((e) => e.type === 'turn.started');

describe('assembleDrawroid, telling where the screen is', () => {
  const MISSING_WEB_LINE =
    'drawroid: web の build が無いので、画面は http://localhost:5173/（開発中）か、pnpm build のあとで配る\n';

  it('says in Japanese where to open the screen when the web has not been built', async () => {
    const written: string[] = [];
    await start(undefined, undefined, (text) => written.push(text));
    expect(written).toContain(MISSING_WEB_LINE);
  });

  it('says nothing about it when the web has been built', async () => {
    await writeFile(join(webRoot, 'index.html'), '<!doctype html>');
    const written: string[] = [];
    await start(undefined, undefined, (text) => written.push(text));
    expect(written.join('')).not.toContain('web の build が無い');
  });
});

describe('assembleDrawroid, telling where the backend kind came from', () => {
  const settingsOf = async (backend: 'forge' | 'a1111' | undefined) => {
    running = await assembleDrawroid({
      root,
      args: { port: 0, backend, backendUrl: 'http://127.0.0.1:9' },
      env: {},
      signals: new EventEmitter(),
      exit: vi.fn(),
      write: () => undefined,
      webRoot,
    });
    const url = `http://127.0.0.1:${running.address.port}/api/settings/backend`;
    return { url, view: (await (await fetch(url)).json()) as Record<string, unknown> };
  };

  it('says the kind comes from the start-up argument when --backend is given', async () => {
    await writeFile(join(root, 'config.json'), JSON.stringify({ backend: { kind: 'forge' } }));
    expect((await settingsOf('a1111')).view).toMatchObject({ kind: 'a1111', kindSource: 'cli' });
  });

  it('says the kind comes from config.json when there is no --backend', async () => {
    await writeFile(join(root, 'config.json'), JSON.stringify({ backend: { kind: 'a1111' } }));
    expect((await settingsOf(undefined)).view).toMatchObject({
      kind: 'a1111',
      kindSource: 'config',
    });
  });

  it('says the kind is the default when neither --backend nor config.json has one', async () => {
    expect((await settingsOf(undefined)).view).toMatchObject({
      kind: 'forge',
      kindSource: 'default',
    });
  });

  it('switches the kind in use when the screen saves one, and reports it as from config.json', async () => {
    const { url } = await settingsOf('forge');
    const saved = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9', kind: 'a1111' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ kind: 'a1111', kindSource: 'config' });
    expect(await (await fetch(url)).json()).toMatchObject({ kind: 'a1111', kindSource: 'config' });
  });

  // 見かけの種類だけでなく、実際に使われるアダプタが替わることを、偽のサーバーへ出す要求の道で見る。
  // VAE の一覧は、A1111 は /sdapi/v1/sd-vae、Forge は /sdapi/v1/sd-modules を叩く
  it('uses the adapter of the kind the screen saved, which asks the A1111 route for the VAE list', async () => {
    const paths: string[] = [];
    const sdapi = createServer((req, res) => {
      paths.push(req.url ?? '');
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
    await new Promise<void>((resolve) => sdapi.listen(0, '127.0.0.1', resolve));
    const sdapiUrl = `http://127.0.0.1:${(sdapi.address() as AddressInfo).port}`;
    try {
      const { url } = await settingsOf('forge');
      const saved = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: sdapiUrl, kind: 'a1111' }),
      });
      expect(saved.status).toBe(200);
      paths.length = 0;

      await fetch(url.replace('/settings/backend', '/backend/candidates/vae'));

      expect(paths).toContain('/sdapi/v1/sd-vae');
      expect(paths).not.toContain('/sdapi/v1/sd-modules');
    } finally {
      await new Promise((resolve) => {
        sdapi.close(resolve);
        sdapi.closeAllConnections();
      });
    }
  });
});

describe('assembleDrawroid, telling whether the start-up arguments are in effect', () => {
  const startWith = async (args: { backend?: 'forge' | 'a1111'; backendUrl?: string }) => {
    running = await assembleDrawroid({
      root,
      args: { port: 0, backend: args.backend, backendUrl: args.backendUrl },
      env: {},
      signals: new EventEmitter(),
      exit: vi.fn(),
      write: () => undefined,
      webRoot,
    });
    return `http://127.0.0.1:${running.address.port}/api/settings/backend`;
  };
  const save = (url: string, body: object) =>
    fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('keeps saying both arguments win next time after the screen saves a kind and a url', async () => {
    const url = await startWith({ backend: 'forge', backendUrl: 'http://127.0.0.1:9' });
    expect(await (await fetch(url)).json()).toMatchObject({
      startupArgs: { kind: true, url: true },
    });
    const saved = await save(url, { url: 'http://127.0.0.1:9', kind: 'a1111' });
    expect(await saved.json()).toMatchObject({
      kindSource: 'config',
      urlSource: 'config',
      startupArgs: { kind: true, url: true },
    });
    expect(await (await fetch(url)).json()).toMatchObject({
      kindSource: 'config',
      urlSource: 'config',
      startupArgs: { kind: true, url: true },
    });
  });

  it('says neither argument is in effect when started without them, also after a save', async () => {
    const url = await startWith({});
    expect(await (await fetch(url)).json()).toMatchObject({
      startupArgs: { kind: false, url: false },
    });
    const saved = await save(url, { url: 'http://127.0.0.1:9', kind: 'a1111' });
    expect(await saved.json()).toMatchObject({ startupArgs: { kind: false, url: false } });
  });

  it('tells the kind and the url apart when only one of them is given at start-up', async () => {
    const url = await startWith({ backend: 'a1111' });
    expect(await (await fetch(url)).json()).toMatchObject({
      startupArgs: { kind: true, url: false },
    });
  });
});

describe('assembleDrawroid after a restart', () => {
  // 落ちる前の止まりで話しかけ直さない: 途切れたターンをやり直さないのと同じく、話しかけるのは止まったその場だけ
  it('does not speak about a job that stopped before the process went down, even if it had not spoken yet', async () => {
    const conversations = new FsConversationStore(root);
    const { conversationId } = await conversations.createConversation(new Date());
    const jobId = await stoppedJobOf(conversationId);
    const now = new Date();
    await conversations.appendEvent(
      conversationId,
      {
        type: 'job.started',
        jobId,
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      },
      now,
    );
    await conversations.appendEvent(
      conversationId,
      {
        type: 'job.stopped',
        jobId,
        reason: { kind: 'ai', detail: '見る役が意図どおりと判断した' },
      },
      now,
    );

    await start();
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    expect(await turnsStarted(conversations, conversationId)).toEqual([]);
  });

  it('does not speak when the restart fills in the stop that was not written to the conversation', async () => {
    const conversations = new FsConversationStore(root);
    const { conversationId } = await conversations.createConversation(new Date());
    const jobId = await stoppedJobOf(conversationId);
    await conversations.appendEvent(
      conversationId,
      {
        type: 'job.started',
        jobId,
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      },
      new Date(),
    );

    await start();
    await vi.waitFor(async () =>
      expect((await conversations.readEvents(conversationId)).events.at(-1)).toMatchObject({
        type: 'job.stopped',
        jobId,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    expect(await turnsStarted(conversations, conversationId)).toEqual([]);
  });

  // 再開したジョブの止まりは、話す役へ届いて話しかける（話す役を立ててからジョブを再開するため）
  it('speaks about a job resumed after a restart once it stops', async () => {
    const { conversations, conversationId, jobId } = await queuedJobWithUnreachableLlm();

    await start();

    await vi.waitFor(
      async () =>
        expect(await turnsStarted(conversations, conversationId)).toEqual([
          expect.objectContaining({ jobId }),
        ]),
      { timeout: 5_000 },
    );
    await turnEnded(conversations, conversationId);
  });

  // 画面を見ていなくても気づけるように、失敗で止まったジョブと、失敗で閉じたターンを、端末に1行ずつ出す
  it('tells the terminal in one line each when the job and the turn fail', async () => {
    const { conversations, conversationId, jobId } = await queuedJobWithUnreachableLlm();
    const written: string[] = [];

    await start(undefined, undefined, (text) => written.push(text));
    await turnEnded(conversations, conversationId);

    // 行が出るまで待つ: ターンの行は turn.ended を確定したあとに出すので、turn.ended が見えた時点ではまだ無いことがあるため
    await vi.waitFor(() => {
      expect(written.filter((line) => line.startsWith('drawroid: 描くのを止めた'))).toEqual([
        expect.stringMatching(
          new RegExp(`^drawroid: 描くのを止めた（ジョブ ${jobId}）: [^\\n]+\\n$`),
        ),
      ]);
      expect(written.filter((line) => line.startsWith('drawroid: 応答が失敗した'))).toEqual([
        expect.stringMatching(
          new RegExp(`^drawroid: 応答が失敗した（会話 ${conversationId}）: [^\\n]+\\n$`),
        ),
      ]);
    });
  });
});

/** 会話に属する、待ち行列のジョブ（落ちる前に積んだ）と、繋がらない LLM の設定を置く */
// 繋がらない LLM（とバックエンド）: 再開したジョブはすぐ error で止まる。話す役のターンも失敗で閉じる
async function queuedJobWithUnreachableLlm() {
  const role = {
    provider: 'local',
    model: 'm',
    structuredOutput: 'native',
    reasoning: 'native',
    toolCalling: 'native',
    imageInput: true,
  };
  await writeLlmSettings(join(root, 'config.json'), {
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' } },
    roles: { think: role },
    validationRetries: 0,
    networkRetries: 0,
  });
  const conversations = new FsConversationStore(root);
  const { conversationId } = await conversations.createConversation(new Date());
  const spec = await new FsJobStore(root).createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: true, maxIterations: 5 },
      batchSize: 1,
      conversationId,
      turn: 1,
    },
    { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
    new Date(),
  );
  return { conversations, conversationId, jobId: spec.jobId };
}

/** ターンが閉じるまで待つ: 閉じる前に片付けると、ターンの書き込みと片付けが重なるため */
async function turnEnded(conversations: FsConversationStore, conversationId: string) {
  await vi.waitFor(
    async () =>
      expect((await conversations.readEvents(conversationId)).events).toContainEqual(
        expect.objectContaining({ type: 'turn.ended' }),
      ),
    { timeout: 5_000 },
  );
}

// 手動の生成を止めるとき、Forge が止めるのに失敗したら、その理由を端末に1行出す（#431。ログの行き先は組み立てがつなぐ）
describe('assembleDrawroid, stopping a manual generation', () => {
  it('tells the terminal in one line when Forge fails to stop the generation', async () => {
    let generationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (generationStarted = resolve));
    // 偽の Forge: txt2img は答えずに持っておき（生成が走っている間）、interrupt には 500 を返す
    const forge = createServer((req, res) => {
      req.resume();
      if (req.url === '/sdapi/v1/txt2img') {
        generationStarted();
        return;
      }
      res.writeHead(req.url === '/sdapi/v1/interrupt' ? 500 : 404, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ detail: '止められない' }));
    });
    await new Promise<void>((resolve) => forge.listen(0, '127.0.0.1', resolve));
    const forgeUrl = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;
    try {
      const written: string[] = [];
      const listening = await start(undefined, undefined, (text) => written.push(text), forgeUrl);
      const api = `http://127.0.0.1:${listening.address.port}/api/jobs/manual`;
      const created = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64 }),
      });
      const { jobId } = (await created.json()) as { jobId: string };
      await started;

      expect((await fetch(`${api}/${jobId}/stop`, { method: 'POST' })).status).toBe(202);

      expect(
        written.filter((line) => line.startsWith(`drawroid: 手動のジョブ ${jobId} を止めるとき`)),
      ).toEqual([expect.stringMatching(/バックエンドが止めるのに失敗した: [^\n]+\n$/)]);
    } finally {
      await new Promise((resolve) => {
        forge.close(resolve);
        forge.closeAllConnections();
      });
    }
  });
});

// 中断（all）が止めるジョブは、組み立てがつなぐ。描く・止めるツールと同じく、走っているものの新しい方を止め、止まったものは止めない
describe('assembleDrawroid, interrupting everything in a conversation', () => {
  it('stops the latest of the jobs going on, and no job that has already stopped', async () => {
    const listening = await start();
    const { conversationId } = await new FsConversationStore(root).createConversation(new Date());
    await stoppedJobOf(conversationId);
    const interruptAll = async () => {
      const response = await fetch(
        `http://127.0.0.1:${listening.address.port}/api/conversations/${conversationId}/interrupt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'all' }),
        },
      );
      expect(response.status).toBe(202);
      return ((await response.json()) as { stoppedJob: string | null }).stoppedJob;
    };

    expect(await interruptAll()).toBeNull();

    const suffixes = ['aaaaaa', 'bbbbbb'];
    const store = new FsJobStore(root, { randomSuffix: () => suffixes.shift() ?? 'cccccc' });
    const queued = async () =>
      (
        await store.createJob(
          {
            kind: 'auto',
            request: '夕暮れの海辺に立つ少女',
            stopConditions: { aiJudgement: true, maxIterations: 5 },
            batchSize: 1,
            conversationId,
            turn: 1,
          },
          { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
          new Date('2026-10-09T06:30:12.000Z'),
        )
      ).jobId;
    const older = await queued();
    const newer = await queued();

    expect(await interruptAll()).toBe(newer);
    expect((await store.readState(newer)).status).toBe('stopped');
    expect((await store.readState(older)).status).toBe('queued');
  });
});

/** 空いているポートを1つ選ぶ（閉じて返す） */
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const startOn = (port: number, dataRoot: string, write: (text: string) => void = () => undefined) =>
  assembleDrawroid({
    root: dataRoot,
    args: { port, backend: undefined, backendUrl: 'http://127.0.0.1:9' },
    env: {},
    signals: new EventEmitter(),
    exit: vi.fn(),
    write,
    webRoot,
  });

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('assembleDrawroid, when the port is already taken', () => {
  let holder: ReturnType<typeof createTcpServer> | undefined;
  afterEach(async () => {
    await new Promise((resolve) => (holder ? holder.close(resolve) : resolve(undefined)));
    holder = undefined;
  });
  const takePort = async () => {
    holder = createTcpServer();
    await new Promise<void>((resolve) => holder!.listen(0, '127.0.0.1', resolve));
    return (holder.address() as AddressInfo).port;
  };

  it('fails with EADDRINUSE without writing any start-up line', async () => {
    const port = await takePort();
    const written: string[] = [];

    await expect(startOn(port, root, (text) => written.push(text))).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });

    expect(written).toEqual([]);
  });

  it('creates nothing in the data directory that did not exist', async () => {
    const port = await takePort();
    const fresh = join(root, '..', 'fresh-data');

    await expect(startOn(port, fresh)).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(await exists(fresh)).toBe(false);
  });

  it('leaves the leftover temporary files of the last run where they are', async () => {
    const port = await takePort();
    await writeFile(join(root, '.tmp-left-over'), 'partial');

    await expect(startOn(port, root)).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(await readdir(root)).toContain('.tmp-left-over');
  });
});

describe('assembleDrawroid, when the start-up fails for another reason', () => {
  it('gives the port back and does not blame the port', async () => {
    await writeFile(join(root, 'config.json'), '{ broken');
    const port = await freePort();
    const written: string[] = [];

    const failure = await startOn(port, root, (text) => written.push(text)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException).code).not.toBe('EADDRINUSE');
    const again = createTcpServer();
    try {
      await new Promise<void>((resolve, reject) => {
        again.once('error', reject);
        again.listen(port, '127.0.0.1', resolve);
      });
    } finally {
      await new Promise((resolve) => again.close(resolve));
    }
  });
});

describe('assembleDrawroid, the lines it writes when it starts', () => {
  it('writes the data directory, the backend and the unset LLM in this order', async () => {
    const written: string[] = [];

    await start(undefined, undefined, (text) => written.push(text));

    const lines = written.join('').split('\n');
    const at = (part: string) => lines.findIndex((line) => line.includes(part));
    expect(at('drawroid: データディレクトリ ')).toBe(0);
    expect(at('drawroid: Forge http://127.0.0.1:9')).toBeGreaterThan(at('データディレクトリ'));
    expect(at('drawroid: LLM が未設定')).toBeGreaterThan(at('drawroid: Forge'));
  });
});

// 待ち受けは組み立ての前に始まる。組み立てが済むまでに来た要求は、断らず、済んでから答える
describe('assembleDrawroid, a request that arrives while it is still assembling', () => {
  it('is answered after the assembly finishes, not refused', async () => {
    let modelsAsked: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => (modelsAsked = resolve));
    let held: import('node:http').ServerResponse | undefined;
    const llm = createServer((req, res) => {
      req.resume();
      held = res;
      modelsAsked?.();
    });
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    await writeLlmSettings(join(root, 'config.json'), {
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
        },
      },
      roles: { think: { provider: 'local', model: 'm' } },
    });
    const port = await freePort();
    try {
      const starting = startOn(port, root).then((listening) => (running = listening));
      // LLM の窓を読む問い合わせが来た = 組み立ての途中
      await asked;
      const early = fetch(`http://127.0.0.1:${port}/api/settings/backend`);
      const settled = vi.fn();
      void early.then(settled, settled);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).not.toHaveBeenCalled();

      held?.writeHead(404).end();
      await starting;

      const res = await early;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: 'forge' });
    } finally {
      llm.closeAllConnections();
      await new Promise((resolve) => llm.close(resolve));
    }
  });
});

describe('assembleDrawroid and the signals to stop', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('ends with the code of %s when it is told to stop', async (signal, code) => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    await start(signals, exit);

    signals.emit(signal);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
  });
});

// LLM から読んだ窓は、端末に1行ずつ出す。名前の合わないモデルから読んだときは、どの id から読んだかを添える（#432）
describe('assembleDrawroid, telling the window it read from the LLM', () => {
  it('names the model it read the window from when the server lists only that one under another name', async () => {
    const llm = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: '/models/a.gguf', meta: { n_ctx: 8192 } }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    const { port } = llm.address() as AddressInfo;
    try {
      await writeLlmSettings(join(root, 'config.json'), {
        providers: {
          local: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${port}/v1` },
        },
        roles: { think: { provider: 'local', model: 'qwen' } },
      });
      const written: string[] = [];

      await start(undefined, undefined, (text) => written.push(text));

      expect(written).toContain(
        'drawroid: think の役の文脈の上限を LLM から読んだ: 8192（/v1/models に1つだけあるモデル /models/a.gguf の窓。設定のモデル名とは一致しない）\n',
      );
    } finally {
      await new Promise((resolve) => llm.close(resolve));
    }
  });
});

// LLM の設定の保存では、contextTokens を書かない役の窓を LLM から読んで予算と比べる。読んだ行は保存のときには出さない（#502）
describe('assembleDrawroid, saving LLM settings that leave the window out', () => {
  it('refuses settings whose window read from the LLM is too small for the budgets, without telling it read the window', async () => {
    const llm = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'qwen', meta: { n_ctx: 1500 } }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    const { port } = llm.address() as AddressInfo;
    try {
      const written: string[] = [];
      const listening = await start(undefined, undefined, (text) => written.push(text));
      const startup = written.length;

      const response = await fetch(`http://127.0.0.1:${listening.address.port}/api/settings/llm`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: {
            local: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${port}/v1` },
          },
          roles: { think: { provider: 'local', model: 'qwen' } },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('1500');
      expect(written.slice(startup).filter((text) => text.includes('LLM から読んだ'))).toEqual([]);
    } finally {
      await new Promise((resolve) => llm.close(resolve));
    }
  });
});

// config.json の llm が壊れていても、起動は止めない（LLM は未設定のまま進む）。どの欄かを日本語で言う
describe('assembleDrawroid with a broken llm in config.json', () => {
  it('starts anyway and names the broken field in Japanese', async () => {
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({ llm: { providers: {}, roles: {} } }),
    );
    const written: string[] = [];

    const listening = await start(undefined, undefined, (text) => written.push(text));

    expect(listening.address.port).toBeGreaterThan(0);
    expect(written).toContain(
      'drawroid: config.json の llm が不正なので未設定のまま進む: config.json の llm.roles.think が読めない（欄が無い）（原文: Invalid input: expected object, received undefined）\n',
    );
  });
});

// 予算の欄ごとの上限の和が窓を超えていても、起動は止めない。端末に1行だけ知らせる
describe('assembleDrawroid with budgets that do not fit the window', () => {
  const llmWith = (contextTokens: number) => ({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' } },
    roles: { think: { provider: 'local', model: 'm', contextTokens } },
  });

  it('says so in one line and starts anyway', async () => {
    await writeLlmSettings(join(root, 'config.json'), llmWith(1500));
    const written: string[] = [];

    const listening = await start(undefined, undefined, (text) => written.push(text));

    expect(listening.address.port).toBeGreaterThan(0);
    const lines = written.join('').split('\n');
    const warned = lines.filter((line) => line.includes('窓に入らない'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('考える役の考える段');
    expect(warned[0]).toContain('1500');
  });

  it('says nothing about the window when the budgets fit', async () => {
    await writeLlmSettings(join(root, 'config.json'), llmWith(8192));
    const written: string[] = [];

    await start(undefined, undefined, (text) => written.push(text));

    expect(written.join('')).not.toContain('窓に入らない');
  });
});

// 窓を書かずに LLM の設定を保存したとき: 窓は /v1/models から読む。読めなかったら比べられなかったことを応答で返し、読みは1回で済ませる
describe('assembleDrawroid, telling what it compared and reading the window once when saving LLM settings', () => {
  type ModelsHandler = (res: import('node:http').ServerResponse) => void;

  /** /v1/models の問い合わせの数を数える偽の LLM を立てて、設定を PUT する。roles を省けば window を書かない */
  async function saveWith(
    models: ModelsHandler,
    roles: Record<string, unknown> = { think: { provider: 'local', model: 'm' } },
  ) {
    let asked = 0;
    const llm = createServer((req, res) => {
      if (req.url === '/v1/models') {
        asked += 1;
        models(res);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    const { port } = llm.address() as AddressInfo;
    try {
      const listening = await start();
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${listening.address.port}/api/settings/llm`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: {
            local: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${port}/v1` },
          },
          roles,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
        asked: () => asked,
        elapsedMs: Date.now() - started,
      };
    } finally {
      llm.closeAllConnections();
      await new Promise((resolve) => llm.close(resolve));
    }
  }

  const answersWith =
    (nCtx: number): ModelsHandler =>
    (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'm', meta: { n_ctx: nCtx } }] }));
    };

  it('saves and says in the response that it did not compare with the window when /v1/models fails', async () => {
    const saved = await saveWith((res) => {
      res.statusCode = 500;
      res.end();
    });

    expect(saved.status).toBe(200);
    expect(saved.body).toHaveProperty('config');
    expect(saved.body).toHaveProperty('apiKeyEnv');
    const note = JSON.stringify(saved.body);
    expect(note).toContain('窓と比べなかった');
    expect(note).toContain('考える役');
    expect(note).toContain('見る役');
  });

  it('saves without any note when the window could be read', async () => {
    const saved = await saveWith(answersWith(65536));

    expect(saved.status).toBe(200);
    expect(Object.keys(saved.body).sort()).toEqual(['apiKeyEnv', 'config']);
  });

  // 窓を書いた役は、/v1/models が読めなくても比べられている。読めなかったことだけで知らせない
  it('saves without any note when every role writes its window, even though /v1/models fails', async () => {
    const saved = await saveWith(
      (res) => {
        res.statusCode = 500;
        res.end();
      },
      {
        think: { provider: 'local', model: 'm', contextTokens: 65536 },
        judge: { provider: 'local', model: 'v', contextTokens: 65536 },
      },
    );

    expect(saved.status).toBe(200);
    expect(Object.keys(saved.body).sort()).toEqual(['apiKeyEnv', 'config']);
  });

  it('asks /v1/models once per save when the window can be read', async () => {
    const saved = await saveWith(answersWith(65536));

    expect(saved.asked()).toBe(1);
  });

  it('asks /v1/models once per save, and returns in about one timeout, when the server does not answer', async () => {
    const saved = await saveWith(() => undefined);

    expect(saved.status).toBe(200);
    expect(saved.asked()).toBe(1);
    expect(saved.elapsedMs).toBeLessThan(8000);
  }, 30_000);
});

// 起動が LLM サーバのモデル読み込み中（/v1/models が 503）に重なって窓を読めなかった役は、LLM が上がったあと、次に使うときに読み直す
describe('assembleDrawroid, reading the window again for an LLM that was still loading at start-up', () => {
  const MINUTE_MS = 60_000;
  const READ_LINE = 'drawroid: think の役の文脈の上限を LLM から読んだ: 32768\n';

  /** 読み込み中（503）から始まる偽の LLM。chat は構造化出力にならない返事だけを返し、ジョブも話す役のターンも1回の呼び出しで閉じる */
  async function loadingLlm() {
    const state = { loaded: false, delayMs: 0, asked: 0 };
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === '/v1/models') {
        state.asked += 1;
        setTimeout(() => {
          res.statusCode = state.loaded ? 200 : 503;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify(
              state.loaded ? { data: [{ id: 'm', meta: { n_ctx: 32768 } }] } : { error: 'loading' },
            ),
          );
        }, state.delayMs);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'いいえ' } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await writeLlmSettings(join(root, 'config.json'), {
      providers: { local: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${port}/v1` } },
      roles: { think: { provider: 'local', model: 'm' } },
      validationRetries: 0,
      networkRetries: 0,
    });
    return {
      state,
      port,
      close: () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    };
  }

  /** 組み立てを、動かせる時計つきで起動する */
  async function startWithClock() {
    const clock = { ms: Date.parse('2026-10-11T00:00:00Z') };
    const written: string[] = [];
    const listening = await assembleDrawroid({
      root,
      args: { port: 0, backend: undefined, backendUrl: 'http://127.0.0.1:9' },
      env: {},
      signals: new EventEmitter(),
      exit: vi.fn(),
      write: (text) => written.push(text),
      webRoot,
      now: () => clock.ms,
    });
    running = listening;
    const api = `http://127.0.0.1:${listening.address.port}/api`;
    const jobs = new FsJobStore(root);
    const conversations = new FsConversationStore(root);
    return {
      api,
      clock,
      written,
      readLines: () => written.filter((line) => line.includes('LLM から読んだ')),
      /** 自動ジョブを1つ投入し、止まるまで待つ（バックエンドが繋がらないので、LLM を呼ぶ前に止まる。窓は端末の行と /v1/models の問い合わせで見る） */
      async runJob() {
        const response = await fetch(`${api}/jobs/auto`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ request: '夕暮れの海辺に立つ少女' }),
        });
        const { jobId } = (await response.json()) as { jobId: string };
        await vi.waitFor(async () => expect((await jobs.readState(jobId)).status).toBe('stopped'), {
          timeout: 10_000,
        });
      },
      /** 会話で1回話しかけ、ターンが閉じるまで待って、その LLM 呼び出しの入力の上限を返す */
      async runTurn() {
        const { conversationId } = await conversations.createConversation(new Date());
        const response = await fetch(`${api}/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'こんにちは' }),
        });
        expect(response.status).toBe(202);
        await turnEnded(conversations, conversationId);
        return (await conversations.listLlmCallRecords(conversationId)).records.map(
          (r) => r.budget.inputTokenLimit,
        );
      },
    };
  }

  let llm: Awaited<ReturnType<typeof loadingLlm>>;
  // 組み立ての中のランナーは外に出ていない: kick を素通しで見張り、呼ばれた相手（ランナー）を控える
  let kicked: ReturnType<typeof vi.spyOn<JobRunner, 'kick'>>;
  beforeEach(async () => {
    kicked = vi.spyOn(JobRunner.prototype, 'kick');
    llm = await loadingLlm();
  });
  afterEach(async () => {
    // ジョブが止まっても、ランナーは待ち行列をもう一度走査している: データディレクトリを消す前に、その走査が終わるのを待つ
    // （待たないと、消えたあとの state.json を読んで Unhandled Rejection になる）
    await Promise.all(kicked.mock.contexts.map((runner) => runner.idle()));
    kicked.mockRestore();
    await llm.close();
  });

  it('says it read the window, once, when the next job starts after the LLM has come up', async () => {
    const app = await startWithClock();
    expect(app.readLines()).toEqual([]);
    llm.state.loaded = true;
    app.clock.ms += 10 * MINUTE_MS;

    await app.runJob();

    expect(app.readLines()).toEqual([READ_LINE]);
  }, 30_000);

  it('applies the window to the next turn of the talk role after the LLM has come up', async () => {
    const app = await startWithClock();
    llm.state.loaded = true;
    app.clock.ms += 10 * MINUTE_MS;

    const limits = await app.runTurn();

    expect(app.readLines()).toEqual([READ_LINE]);
    expect(limits.length).toBeGreaterThan(0);
    expect(new Set(limits)).toEqual(new Set([32768 - 1024]));
  }, 30_000);

  it('does not ask /v1/models again once every role has its window', async () => {
    const app = await startWithClock();
    llm.state.loaded = true;
    app.clock.ms += 10 * MINUTE_MS;
    await app.runJob();
    const askedAfterReread = llm.state.asked;

    app.clock.ms += 10 * MINUTE_MS;
    await app.runJob();
    await app.runTurn();

    expect(llm.state.asked).toBe(askedAfterReread);
    expect(app.readLines()).toEqual([READ_LINE]);
  }, 30_000);

  it('does not ask /v1/models again within a short time of the last read, even while the server is still not ready', async () => {
    const app = await startWithClock();
    const askedAtStartup = llm.state.asked;

    await app.runJob();
    app.clock.ms += 1000;
    await app.runJob();
    await app.runTurn();

    expect(llm.state.asked).toBe(askedAtStartup);
  }, 30_000);

  it('asks again at a later use when the server is still not ready at the first re-read', async () => {
    const app = await startWithClock();
    app.clock.ms += 10 * MINUTE_MS;
    await app.runJob();
    expect(llm.state.asked).toBe(2);
    expect(app.readLines()).toEqual([]);

    llm.state.loaded = true;
    app.clock.ms += 10 * MINUTE_MS;
    const limits = await app.runTurn();

    expect(llm.state.asked).toBe(3);
    expect(app.readLines()).toEqual([READ_LINE]);
    expect(new Set(limits)).toEqual(new Set([32768 - 1024]));
  }, 30_000);

  it('waits out the interval after a re-read that also could not read the window', async () => {
    const app = await startWithClock();
    app.clock.ms += 30_000;
    await app.runJob();
    expect(llm.state.asked).toBe(2);

    await app.runJob();
    app.clock.ms += 1_000;
    await app.runJob();
    await app.runTurn();

    expect(llm.state.asked).toBe(2);
  }, 30_000);

  it('re-reads at 30 seconds after the last read and not at 29 seconds', async () => {
    const app = await startWithClock();
    expect(llm.state.asked).toBe(1);

    app.clock.ms += 29_000;
    await app.runJob();
    expect(llm.state.asked).toBe(1);

    app.clock.ms += 1_000;
    await app.runJob();
    expect(llm.state.asked).toBe(2);
  }, 30_000);

  it('counts the read made when saving the LLM settings as the last read', async () => {
    const app = await startWithClock();
    app.clock.ms += 600_000;
    const saved = await fetch(`${app.api}/settings/llm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          local: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${llm.port}/v1` },
        },
        roles: { think: { provider: 'local', model: 'm' } },
      }),
    });
    expect(saved.status).toBe(200);
    const askedAfterSave = llm.state.asked;
    expect(askedAfterSave).toBe(2);

    await app.runJob();
    app.clock.ms += 1_000;
    await app.runJob();
    await app.runTurn();

    expect(llm.state.asked).toBe(askedAfterSave);
  }, 30_000);

  it('throws away the window it read when the LLM settings were replaced while it was reading', async () => {
    const app = await startWithClock();
    const askedAtStartup = llm.state.asked;
    llm.state.loaded = true;
    llm.state.delayMs = 500;
    app.clock.ms += 10 * MINUTE_MS;

    const started = await fetch(`${app.api}/jobs/auto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: '夕暮れの海辺に立つ少女' }),
    });
    const { jobId } = (await started.json()) as { jobId: string };
    // 読み直しが /v1/models の返事を待っている間に、窓を書いた設定を保存する
    await vi.waitFor(() => expect(llm.state.asked).toBe(askedAtStartup + 1), { timeout: 10_000 });
    const saved = await fetch(`${app.api}/settings/llm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          local: { type: 'openai-compatible', baseURL: `http://127.0.0.1:${llm.port}/v1` },
        },
        roles: { think: { provider: 'local', model: 'm', contextTokens: 16384 } },
      }),
    });
    expect(saved.status).toBe(200);
    const jobs = new FsJobStore(root);
    await vi.waitFor(async () => expect((await jobs.readState(jobId)).status).toBe('stopped'), {
      timeout: 10_000,
    });

    const limits = await app.runTurn();

    expect(app.readLines()).toEqual([]);
    expect(limits.length).toBeGreaterThan(0);
    expect(new Set(limits)).toEqual(new Set([16384 - 1024]));
  }, 30_000);

  it('asks /v1/models once when a job and a turn start at the same time', async () => {
    const app = await startWithClock();
    const askedAtStartup = llm.state.asked;
    llm.state.loaded = true;
    llm.state.delayMs = 400;
    app.clock.ms += 10 * MINUTE_MS;

    await Promise.all([app.runJob(), app.runTurn()]);

    expect(llm.state.asked).toBe(askedAtStartup + 1);
    expect(app.readLines()).toEqual([READ_LINE]);
  }, 30_000);
});
