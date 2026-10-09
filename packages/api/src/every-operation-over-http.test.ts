// M3 の操作を、HTTP だけで通しで行う試験（M3:98「上の操作がすべて HTTP API の上に乗っている」）。
// 組み立てのあとは app.request だけを使い、置き場所（store）にもランナーにも直に触れない。
// ここで通る操作に画面だけの経路は要らない、ということをこの1本で示す
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET,
  JobRunner,
  ManualGenerationRunner,
  THINK_PARAM_KEYS,
  type LlmCall,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from './index.js';

const INTEGRATED = '逆光で、夕暮れの海辺に立つ白いワンピースの少女';

// 口出しを載せた回には統合した要点を返す（求められていない回はスキーマが落とす）
const think: Script = (_call: LlmCall<unknown>, n: number) => ({
  params: {
    prompt: `girl, beach, take ${n + 1}`,
    negativePrompt: 'lowres',
    seed: -1,
    steps: 20,
    cfg: 7,
  },
  rationale: `${n + 1} 回目の案`,
  intent: INTEGRATED,
});

const judge: Script = (call: LlmCall<unknown>) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map((_, i) => ({ score: 0.5 + i * 0.1, issues: ['背景が暗い'] })),
  nextChange: 'もっと逆光にする',
  canStop: false,
});

let root: string;
let runner: JobRunner;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-m3-over-http-'));
  const store = new FsJobStore(root);
  // 生成に少し時間を掛ける: 回の途中に口出しを挟めるように
  const backend = new StubBackend({ generateDelayMs: 30 });
  runner = new JobRunner({
    store,
    llm: new ScriptedLlm({ think, judge }),
    backend,
    budget: DEFAULT_BUDGET,
    allowed: THINK_PARAM_KEYS,
    defaults: { width: 64, height: 64, steps: 20, cfgScale: 7, negativePrompt: '' },
  });
  app = createApi({
    backend,
    store,
    manualRunner: new ManualGenerationRunner({ backend, store }),
    backendSettings: {
      read: () => Promise.reject(new Error('この試験では使わない')),
      write: () => Promise.reject(new Error('この試験では使わない')),
    },
    autoQueue: runner,
    budget: DEFAULT_BUDGET,
    llmSettings: { read: async () => undefined, write: async () => undefined },
    stopConditionParser: { parse: () => Promise.reject(new Error('この試験では使わない')) },
    env: {},
  });
});
afterEach(async () => {
  await runner.idle();
  await rm(root, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  // 応答の形は各ルートの試験が見る。ここでは通しの流れだけを見るので、形を型にしない
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

/** 読み取りの API を、条件を満たすまで読み直す */
async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`待ちきれなかった: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const detail = async (jobId: string) => (await call('GET', `/jobs/${jobId}`)).body;

/** その回の「考える」の呼び出しの記録の、入力の文字列 */
async function thinkInputOf(jobId: string, iteration: number): Promise<string> {
  const list = await call('GET', `/jobs/${jobId}/llm-calls?iteration=${iteration}`);
  const thinkCall = list.body.calls.find((c: { purpose: string }) => c.purpose === 'think');
  const record = await call('GET', `/jobs/${jobId}/llm-calls/${thinkCall.callId}`);
  return record.body.input.user.map((part: { text?: string }) => part.text ?? '').join('\n');
}

describe('every M3 operation goes over HTTP (M3:98)', () => {
  it('submits, watches, instructs, changes the stop conditions, stops, selects and reads back', async () => {
    // 1. 自動ジョブの投入
    const submitted = await call('POST', '/jobs/auto', {
      request: '夕暮れの海辺に立つ白いワンピースの少女、アニメ調',
      stopConditions: { aiJudgement: false, maxIterations: 50 },
      batchSize: 2,
    });
    expect(submitted.status).toBe(202);
    const { jobId } = submitted.body as { jobId: string };

    // 2. 回が進むのを読み取りの API で見る
    const running = await pollUntil(
      () => detail(jobId),
      (d) => d.state.status === 'running' && d.iterations[0]?.judge != null,
    );
    expect(running.iterations[0].images).toHaveLength(2);

    // 3. 人間の指示を入れる
    const instructed = await call('POST', `/jobs/auto/${jobId}/interventions`, {
      kind: 'instruction',
      text: '逆光にして',
    });
    expect(instructed.status).toBe(202);

    // 4. 止める条件を変える（止まらなくなる変更は理由付きで断られる）
    const refused = await call('POST', `/jobs/auto/${jobId}/interventions`, {
      kind: 'stopConditions',
      stopConditions: { maxIterations: null },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('止まらなくなる');
    const changed = await call('POST', `/jobs/auto/${jobId}/interventions`, {
      kind: 'stopConditions',
      stopConditions: { maxIterations: 1000 },
    });
    expect(changed.status).toBe(202);
    expect(changed.body.stopConditions).toEqual({ aiJudgement: false, maxIterations: 1000 });

    // 指示を取り込んだ回を、口出しの読み取りの API で見る。どの回になるかは生成の進み具合で変わる
    const taken = await pollUntil(
      async () => (await call('GET', `/jobs/auto/${jobId}/interventions`)).body.interventions,
      (list: { kind: string; appliedInIteration?: number }[]) =>
        list.some((i) => i.kind === 'instruction' && i.appliedInIteration !== undefined),
    );
    const takenIn = taken.find((i) => i.kind === 'instruction')?.appliedInIteration as number;
    // 受けた順に並ぶ: 同じ秒に続けて受けても、指示 → 止める条件の変更の順のまま
    expect(taken.map((i) => i.kind)).toEqual(['instruction', 'stopConditions']);
    // 取り込んだ回の次の回まで「見る」が済むのを待つ: 指示と変更が次の回から効いたかを、記録で確かめるため
    const last = takenIn + 1;
    await pollUntil(
      () => detail(jobId),
      (d) => d.iterations.filter((i: { judge: unknown }) => i.judge !== null).length >= last,
    );

    // 5. 止める
    expect((await call('POST', `/jobs/auto/${jobId}/stop`)).status).toBe(202);
    const stopped = await pollUntil(
      () => detail(jobId),
      (d) => d.state.status === 'stopped',
    );
    expect(stopped.state.reason.kind).toBe('human');
    expect(stopped.state.carry.intent).toBe(INTEGRATED);

    // 6. 選択を付ける
    const selected = await call('PUT', `/jobs/${jobId}/selections/1-1`, { verdict: 'favorite' });
    expect(selected.status).toBe(200);
    expect(
      (await call('PUT', `/jobs/${jobId}/selections/1-0`, { verdict: 'rejected' })).status,
    ).toBe(200);

    // 7. 詳細・回・LLM の記録・選択を読む
    const listed = await call('GET', '/jobs');
    expect(listed.body.jobs.map((j: { jobId: string }) => j.jobId)).toContain(jobId);

    expect(stopped.spec).toMatchObject({ kind: 'auto', stopConditions: { maxIterations: 50 } });
    const iteration1 = await call('GET', `/jobs/${jobId}/iterations/1`);
    expect(iteration1.status).toBe(200);
    expect(iteration1.body.think).toMatchObject({ rationale: '1 回目の案' });
    expect(iteration1.body.judge).toMatchObject({ nextChange: 'もっと逆光にする' });
    // 応答の URL は cli が API を載せる /api から始まる。ここでは API を直に組んでいるので外して読む
    const image = await app.request(iteration1.body.images[1].url.replace(/^\/api/, ''));
    expect(image.status).toBe(200);

    const calls = await call('GET', `/jobs/${jobId}/llm-calls`);
    expect(calls.body.total.calls).toBeGreaterThanOrEqual(2 * last);
    // 指示は、取り込んだ回の「考える」にだけ「人間の指示:」として載る
    const thinks = await Promise.all(
      Array.from({ length: last }, (_, i) => thinkInputOf(jobId, i + 1)),
    );
    expect(thinks.map((text) => text.includes('人間の指示:\n- 逆光にして'))).toEqual(
      thinks.map((_, i) => i + 1 === takenIn),
    );
    expect(thinks[last - 1]).toContain(INTEGRATED);
    // 止める条件の変更は、変えたあとの「考える」の残り回数に効いている
    expect(thinks[last - 1]).toMatch(/残り 9\d\d 回/);

    const selections = await call('GET', `/jobs/${jobId}/selections`);
    expect(selections.body.selections).toEqual([
      { imageKey: '1-0', verdict: 'rejected', score: 0.5, issues: ['背景が暗い'] },
      { imageKey: '1-1', verdict: 'favorite', score: 0.6, issues: ['背景が暗い'] },
    ]);
  });
});
