// 再起動からの復帰（途切れたターンを閉じる・書き漏らしたジョブのイベントを補う）と、会話からの記憶
// （remember・蒸留の材料への会話の発言）を見る試験（会話 K、#118）。置き場所は本物のファイル、LLM は台本どおりに返すスタブ
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backfillJobEvents,
  basicPermissions,
  bridgeJobEvents,
  closeInterruptedTurns,
  ConversationHubs,
  conversationMessagesFor,
  createMemoryTools,
  createReadOnlyTools,
  DEFAULT_BUDGET,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  RESTART_REASON,
  type ConversationEvent,
  type JobStore,
  type TalkToolContext,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { FsJobStore } from './job-store.js';
import { createFsMemoryStore } from './memory/store.js';
import { dataPaths } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-conversation-recovery-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
  intent: '夕暮れの海辺に立つ少女、逆光',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

const jobKeys = (events: ConversationEvent[]) =>
  events.flatMap((e) =>
    e.type.startsWith('job.') ? [`${e.type}${'iteration' in e ? `:${e.iteration}` : ''}`] : [],
  );

async function runJob(jobs: JobStore, conversationId: string, turn = 1) {
  const runner = new JobRunner({
    store: jobs,
    llm: new ScriptedLlm({ think, judge }),
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
  });
  const spec = await jobs.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺に立つ少女',
      stopConditions: { aiJudgement: false, maxIterations: 2 },
      batchSize: 1,
      conversationId,
      turn,
    },
    { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
    new Date(),
  );
  await runner.addInstruction(spec.jobId, '逆光にして');
  runner.kick();
  await runner.idle();
  return spec;
}

describe('closing the turns a restart cut off', () => {
  it('closes a turn that started but never ended as interrupted, once, and leaves ended turns alone', async () => {
    const store = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store });
    const { conversationId } = await store.createConversation(new Date());
    const hub = hubs.get(conversationId);
    await hub.confirm({ type: 'user.message', text: '何ができますか？' });
    await hub.confirm({ type: 'turn.started', turn: 1, messageSeqs: [1] });
    await hub.confirm({ type: 'turn.ended', turn: 1, outcome: 'done' });
    await hub.confirm({ type: 'user.message', text: '海辺を描いて' });
    await hub.confirm({ type: 'turn.started', turn: 2, messageSeqs: [4] });

    // 再起動したつもりで、新しいハブから閉じる
    const restarted = new ConversationHubs({ store });
    expect(await closeInterruptedTurns({ store, hubs: restarted })).toBe(1);
    expect(await closeInterruptedTurns({ store, hubs: restarted })).toBe(0);

    const ended = (await store.readEvents(conversationId)).events.filter(
      (e) => e.type === 'turn.ended',
    );
    expect(ended).toEqual([
      expect.objectContaining({ turn: 1, outcome: 'done' }),
      expect.objectContaining({ turn: 2, outcome: 'interrupted', reason: RESTART_REASON }),
    ]);
  });

  it('finds the open turn at the end of a long conversation without reading it from the start', async () => {
    const store = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store });
    const { conversationId } = await store.createConversation(new Date());
    const hub = hubs.get(conversationId);
    // 本物のファイルに書くので、件数は試験の時間に収まる程度にする（頭から読めば 262 件。下の 200 件の上限より多く、
    // 末尾から読む分（50 件ずつ 2 回）より十分に多い）。CI が混んだときに 5 秒を超えないよう、書く数を絞っている
    for (let turn = 1; turn <= 60; turn++) {
      const { seq } = await hub.confirm({ type: 'user.message', text: `${turn}` });
      await hub.confirm({ type: 'turn.started', turn, messageSeqs: [seq] });
      await hub.confirm({ type: 'turn.ended', turn, outcome: 'done' });
    }
    const { seq } = await hub.confirm({ type: 'user.message', text: '描いて' });
    await hub.confirm({ type: 'turn.started', turn: 61, messageSeqs: [seq] });
    // 開いたターンのあとに、ターンの記録でないイベントが1回ぶんの読みより多く続いても見つける
    for (let i = 0; i < 80; i++) {
      await hub.confirm({ type: 'tool.call', turn: 61, callId: `c${i}`, name: 'x', input: {} });
    }
    let fromStart = 0;
    let readFromTail = 0;
    const counting = Object.assign(Object.create(store) as FsConversationStore, {
      readEvents: async (...args: Parameters<FsConversationStore['readEvents']>) => {
        fromStart++;
        return store.readEvents(...args);
      },
      readEventsBefore: async (...args: Parameters<FsConversationStore['readEventsBefore']>) => {
        const events = await store.readEventsBefore(...args);
        readFromTail += events.length;
        return events;
      },
    });

    const restarted = new ConversationHubs({ store });
    expect(await closeInterruptedTurns({ store: counting, hubs: restarted })).toBe(1);

    expect(fromStart).toBe(0);
    expect(readFromTail).toBeLessThan(200);
    const last = await store.readEventsBefore(conversationId, { limit: 1 });
    expect(last).toEqual([
      expect.objectContaining({ type: 'turn.ended', turn: 61, outcome: 'interrupted' }),
    ]);
  });
});

describe('filling in the job events a restart left out', () => {
  it('adds the events of the stages whose files exist, without doubling the ones already there', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    // 見る段のイベントだけが書けなかった（段のファイルは書けたが、イベントを書く前に落ちた）つもり
    const failing = new ConversationHubs({ store: conversations });
    const hub = failing.get(conversationId);
    const confirm = hub.confirm.bind(hub);
    hub.confirm = (event) =>
      event.type === 'job.judge' ? Promise.reject(new Error('落ちた')) : confirm(event);
    const files = new FsJobStore(root);
    await runJob(bridgeJobEvents(files, { hubs: failing }), conversationId);
    const before = jobKeys((await conversations.readEvents(conversationId)).events);
    expect(before).not.toContain('job.judge:1');

    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(2);
    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(0);

    const after = jobKeys((await conversations.readEvents(conversationId)).events);
    expect([...after].sort()).toEqual(
      [
        'job.started',
        'job.intervention:1',
        'job.think:1',
        'job.images:1',
        'job.judge:1',
        'job.think:2',
        'job.images:2',
        'job.judge:2',
        'job.stopped',
      ].sort(),
    );
    expect(new Set(after).size).toBe(after.length);
  });

  it('adds job.adopted after the images of an iteration a human settled, and never doubles it', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const files = new FsJobStore(root);
    const spec = await runJob(files, conversationId);
    // 2 回目は見る役を通らず、人が選んで済んだ（評価の代わりに adopted.json が在る）つもり
    await rm(dataPaths(root).jobFiles(spec.jobId).iteration(2).judge);
    await files.writeAdopted(spec.jobId, 2, {
      by: 'human',
      image: { iteration: 2, index: 0 },
      score: 1,
      interventionId: 'int-1',
      adoptedAt: '2026-10-09T15:30:00+09:00',
    });

    await backfillJobEvents({ jobs: files, conversations, hubs });
    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(0);

    const events = (await conversations.readEvents(conversationId)).events;
    expect(jobKeys(events)).toEqual([
      'job.started',
      'job.intervention:1',
      'job.think:1',
      'job.images:1',
      'job.judge:1',
      'job.think:2',
      'job.images:2',
      'job.adopted:2',
      'job.stopped',
    ]);
    expect(events.find((e) => e.type === 'job.adopted')).toMatchObject({
      jobId: spec.jobId,
      image: { iteration: 2, index: 0 },
    });
  });

  it('does not add job.adopted again when the bridge already confirmed it', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const files = new FsJobStore(root);
    const bridged = bridgeJobEvents(files, { hubs });
    const spec = await runJob(bridged, conversationId);
    await rm(dataPaths(root).jobFiles(spec.jobId).iteration(2).judge);
    await bridged.writeAdopted(spec.jobId, 2, {
      by: 'human',
      image: { iteration: 2, index: 0 },
      score: 1,
      interventionId: 'int-1',
      adoptedAt: '2026-10-09T15:30:00+09:00',
    });

    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(0);

    const adoptedEvents = (await conversations.readEvents(conversationId)).events.filter(
      (e) => e.type === 'job.adopted',
    );
    expect(adoptedEvents).toHaveLength(1);
  });

  it('adds the mark of a choice taken in after its iteration once, and not again when the bridge confirmed it', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const files = new FsJobStore(root);
    const bridged = bridgeJobEvents(files, { hubs });
    const spec = await runJob(bridged, conversationId);
    const choose = (index: number) =>
      files.addIntervention(
        spec.jobId,
        { kind: 'adopt', image: { iteration: 1, index } },
        new Date(),
      );
    const adoptMarks = async () =>
      (await conversations.readEvents(conversationId)).events.filter(
        (e) => e.type === 'job.intervention' && e.kind === 'adopt',
      );

    // 1回目のあとの境目で取り込み、印は書けたが、イベントを書く前に落ちたつもり
    const lost = await choose(0);
    await files.markInterventionApplied(spec.jobId, lost.interventionId, 1);
    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(1);
    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(0);
    expect(await adoptMarks()).toEqual([
      expect.objectContaining({ interventionId: lost.interventionId, iteration: 1 }),
    ]);

    // 橋渡しが確定したものは、書き足さない
    const confirmed = await choose(0);
    await bridged.markInterventionApplied(spec.jobId, confirmed.interventionId, 1);
    expect(await backfillJobEvents({ jobs: files, conversations, hubs })).toBe(0);
    expect(
      (await adoptMarks()).map((e) => e.type === 'job.intervention' && e.interventionId),
    ).toEqual([lost.interventionId, confirmed.interventionId]);
  });

  it('writes every event of a job whose events were never written at all, in the order they happened', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const files = new FsJobStore(root);
    // 橋渡しを通さずに回したジョブ（会話のイベントが1件も無い）
    await runJob(files, conversationId);

    await backfillJobEvents({ jobs: files, conversations, hubs });

    expect(jobKeys((await conversations.readEvents(conversationId)).events)).toEqual([
      'job.started',
      'job.intervention:1',
      'job.think:1',
      'job.images:1',
      'job.judge:1',
      'job.think:2',
      'job.images:2',
      'job.judge:2',
      'job.stopped',
    ]);
  });

  it('carries the thinking left in the stage files onto the think and judge events it writes', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const files = new FsJobStore(root);
    // 思考は段の出力（think.json・judge.json）に残る。橋渡しを通さずに回し、イベントは書き足しだけで出す
    const runner = new JobRunner({
      store: files,
      llm: new ScriptedLlm(
        { think, judge },
        {
          reasoning: {
            think: (_call, n) => `考える思考${n}`,
            judge: (_call, n) => `見る思考${n}`,
          },
        },
      ),
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions: basicPermissions({ width: 64, height: 64 }),
    });
    await files.createJob(
      {
        kind: 'auto',
        request: '夕暮れの海辺に立つ少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
        conversationId,
        turn: 1,
      },
      { status: 'queued', carry: { intent: '夕暮れの海辺に立つ少女', completedIterations: 0 } },
      new Date(),
    );
    runner.kick();
    await runner.idle();

    await backfillJobEvents({ jobs: files, conversations, hubs });

    const events = (await conversations.readEvents(conversationId)).events;
    expect(events.find((e) => e.type === 'job.think')).toMatchObject({
      reasoning: expect.stringMatching(/^考える思考\d+$/),
    });
    expect(events.find((e) => e.type === 'job.judge')).toMatchObject({
      reasoning: expect.stringMatching(/^見る思考\d+$/),
    });
  });
});

describe('the words of the conversation in the distillation of its job', () => {
  it('gives the human words from the turn that made the job until the job stopped', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const hub = hubs.get(conversationId);
    await hub.confirm({ type: 'user.message', text: '何ができますか？' });
    await hub.confirm({ type: 'turn.started', turn: 1, messageSeqs: [1] });
    await hub.confirm({ type: 'turn.ended', turn: 1, outcome: 'done' });
    await hub.confirm({ type: 'user.message', text: '海辺の少女を描いて' });
    await hub.confirm({ type: 'turn.started', turn: 2, messageSeqs: [4] });
    const jobs = bridgeJobEvents(new FsJobStore(root), { hubs });
    const spec = await jobs.createJob(
      {
        kind: 'auto',
        request: '海辺の少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
        conversationId,
        turn: 2,
      },
      { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
      new Date(),
    );
    await hub.confirm({ type: 'user.message', text: '指は崩さないで' });
    await jobs.writeState(spec.jobId, {
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      imagesGenerated: 0,
      reason: { kind: 'human', detail: '止めた' },
    });
    await hub.confirm({ type: 'user.message', text: 'ありがとう' });

    const messages = await conversationMessagesFor(conversations)(
      (await jobs.readJob(spec.jobId)) as Extract<
        Awaited<ReturnType<JobStore['readJob']>>,
        { kind: 'auto' }
      >,
    );

    expect(messages.map((m) => m.text)).toEqual(['海辺の少女を描いて', '指は崩さないで']);
  });

  it('puts them into what the stopped job distills', async () => {
    const conversations = new FsConversationStore(root);
    const hubs = new ConversationHubs({ store: conversations });
    const { conversationId } = await conversations.createConversation(new Date());
    const hub = hubs.get(conversationId);
    await hub.confirm({ type: 'user.message', text: '指が崩れているのは嫌。海辺を描いて' });
    await hub.confirm({ type: 'turn.started', turn: 1, messageSeqs: [1] });
    const memory = createFsMemoryStore(dataPaths(root).memory);
    const distilled: string[] = [];
    const llm = new ScriptedLlm({
      think,
      judge,
      distill: (call) => {
        distilled.push(call.messages.user.map((p) => (p.type === 'text' ? p.text : '')).join(''));
        return { operations: [] };
      },
    });
    const jobs = new FsJobStore(root);
    const runner = new JobRunner({
      store: jobs,
      llm,
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions: basicPermissions({ width: 64, height: 64 }),
      memory: {
        store: memory,
        distillLog: { append: async () => undefined, read: async () => [] },
        conversationMessages: conversationMessagesFor(conversations),
      },
    });
    await jobs.createJob(
      {
        kind: 'auto',
        request: '海辺',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
        conversationId,
        turn: 1,
      },
      { status: 'queued', carry: { intent: '海辺', completedIterations: 0 } },
      new Date(),
    );
    runner.kick();
    await runner.idle();

    expect(distilled).toHaveLength(1);
    expect(distilled[0]).toContain('会話での人間の発言: 指が崩れているのは嫌。海辺を描いて');
  });
});

describe('remember', () => {
  it('writes a preference whose sources name the conversation, and another conversation can recall it', async () => {
    const memory = createFsMemoryStore(dataPaths(root).memory);
    const [remember] = createMemoryTools({
      memory,
      now: () => new Date('2026-10-09T06:30:12.000Z'),
      newMemoryId: () => 'backlight',
    });
    const context = (conversationId: string): TalkToolContext => ({
      conversationId,
      turn: 1,
      events: [],
      limits: DEFAULT_TALK_LIMITS,
      signal: new AbortController().signal,
    });

    const said = await remember!.run(
      remember!.inputSchema.parse({ body: '逆光が好き', scope: 'tagged', tags: ['海辺'] }),
      context('20261009-063012-conv1'),
    );

    expect(said.ok).toBe(true);
    expect(await memory.get('backlight')).toMatchObject({
      body: '逆光が好き',
      scope: 'tagged',
      tags: ['海辺'],
      sources: ['conversation:20261009-063012-conv1'],
    });
    const recall = createReadOnlyTools({
      backend: new StubBackend(),
      permissions: async () => basicPermissions({ width: 64, height: 64 }),
      memory,
      jobs: new FsJobStore(root),
    }).find((tool) => tool.name === 'recall_memory')!;
    const recalled = await recall.run({ query: '海辺の少女' }, context('20261009-070000-conv2'));
    expect(recalled.result).toContain('逆光が好き');
  });

  it('does not write the same body twice, and adds the conversation to the sources of the one there is', async () => {
    const memory = createFsMemoryStore(dataPaths(root).memory);
    const ids = ['backlight', 'second', 'third'];
    const [remember] = createMemoryTools({
      memory,
      now: () => new Date('2026-10-09T06:30:12.000Z'),
      newMemoryId: () => ids.shift()!,
    });
    const context = (conversationId: string): TalkToolContext => ({
      conversationId,
      turn: 1,
      events: [],
      limits: DEFAULT_TALK_LIMITS,
      signal: new AbortController().signal,
    });
    const say = (body: string, conversationId: string) =>
      remember!.run(
        remember!.inputSchema.parse({ body, scope: 'always' }),
        context(conversationId),
      );

    await say('逆光が好き', '20261009-063012-conv1');
    // 別の会話で、前後の空白だけが違う同じ本文を頼まれる
    const again = await say('  逆光が好き \n', '20261009-070000-conv2');
    // 同じ会話でもう一度頼まれる
    const thrice = await say('逆光が好き', '20261009-070000-conv2');

    const { items } = await memory.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'backlight',
      body: '逆光が好き',
      sources: ['conversation:20261009-063012-conv1', 'conversation:20261009-070000-conv2'],
    });
    // 話す役が人に「もう覚えていた」と伝えられる結果を返す
    expect(again.ok).toBe(true);
    expect(again.result).toContain('既にあった');
    expect(again.result).toContain('backlight');
    expect(thrice.ok).toBe(true);
    expect(thrice.result).toContain('既にあった');
  });

  it('refuses a tagged preference without the words it applies to', () => {
    const [remember] = createMemoryTools({
      memory: createFsMemoryStore(dataPaths(root).memory),
      now: () => new Date(),
    });

    expect(remember!.inputSchema.safeParse({ body: '逆光', scope: 'tagged' }).success).toBe(false);
  });
});
