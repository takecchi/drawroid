// 会話に人間の発言・中断が割り込むときの動き（会話 I、#115）を、会話の実行器（TalkRunner）とジョブの実行器（JobRunner）を
// 本物のファイルの置き場所の上でつないで見る試験。
// LLM は台本（話す役の本文が流れている途中で止まる呼び出しも作れる）、バックエンドはスタブで、
// 見る役の呼び出し・生成・ツールの実行を「合図まで返さない」形にして、割り込みの時点を決まって作る
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeJobOfConversation,
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  createDrawingTools,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  relayJobHeld,
  TalkRunner,
  type ConversationEvent,
  type HubMessage,
  type JobState,
  type StopConditions,
  type TalkStepCall,
  type TalkStepPart,
  type TalkTool,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script, type TalkScript } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { FsJobStore } from './job-store.js';
import { blocking, GatedBackend } from './testing/hold-gates.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-conversation-interrupts-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = (_call, n) => ({
  params: {
    prompt: `girl, beach ${n + 1}`,
    negativePrompt: 'lowres',
    seed: 7 + n,
    steps: 20,
    cfgScale: 6,
  },
  rationale: '案',
  intent: '海辺の少女、夕焼け',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

/** 指定した n 回目の話す役の呼び出しで、本文を少し流してから、abort されるまで返らない LLM */
class TalkLlm extends ScriptedLlm {
  constructor(
    scripts: ConstructorParameters<typeof ScriptedLlm>[0],
    talk: TalkScript,
    private readonly hangs: ReadonlyMap<number, string>,
  ) {
    super(scripts, { talk });
  }

  override async *streamStep(call: TalkStepCall): AsyncIterable<TalkStepPart> {
    const partial = this.hangs.get(this.steps.length);
    if (partial === undefined) {
      yield* super.streamStep(call);
      return;
    }
    this.steps.push(call);
    yield { type: 'text-delta', text: partial };
    await new Promise<never>((_, reject) =>
      call.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('呼び手が止めた'), { name: 'AbortError' })),
        { once: true },
      ),
    );
  }
}

type SetupOptions = {
  think?: Script;
  judge?: Script;
  backend?: StubBackend;
  talk?: TalkScript;
  /** 話す役の n 回目の呼び出しを、この本文を流したところで止める */
  hangs?: Record<number, string>;
  /** start_drawing の実行を、open() まで待たせる */
  gateStartDrawing?: boolean;
};

async function setup(options: SetupOptions = {}) {
  const conversations = new FsConversationStore(root);
  const hubs = new ConversationHubs({ store: conversations });
  const jobs = bridgeJobEvents(new FsJobStore(root), { hubs });
  const llm = new TalkLlm(
    { think: options.think ?? think, judge: options.judge ?? judge },
    options.talk ?? (() => ({ text: 'はい' })),
    new Map(Object.entries(options.hangs ?? {}).map(([n, text]) => [Number(n), text])),
  );
  const backend = options.backend ?? new StubBackend();
  const permissions = basicPermissions({ width: 64, height: 64 });
  const jobRunner = new JobRunner({
    store: jobs,
    llm,
    backend,
    budget: DEFAULT_BUDGET,
    permissions,
    onLlmStagesHeld: relayJobHeld({ store: jobs, hubs }),
  });
  const drawing = createDrawingTools({
    jobs,
    runner: jobRunner,
    conversations,
    humanPermissions: async () => permissions,
    candidateNames: async () => [],
    defaultStopConditions: async () => ({ aiJudgement: false, maxIterations: 1 }),
    budgets: async () => DEFAULT_BUDGETS,
    now: () => new Date(),
  });
  let openTool: () => void = () => undefined;
  const toolEntered = { value: false };
  const toolGate = new Promise<void>((resolve) => (openTool = resolve));
  const tools: TalkTool[] = drawing.map((tool) =>
    options.gateStartDrawing === true && tool.name === 'start_drawing'
      ? {
          ...tool,
          async run(input, context) {
            toolEntered.value = true;
            await toolGate;
            return tool.run(input, context);
          },
        }
      : tool,
  );
  const talk = new TalkRunner({
    store: conversations,
    hubs,
    llm: () => llm,
    tools,
    limits: async () => DEFAULT_TALK_LIMITS,
    jobs: {
      active: (conversationId) => activeJobOfConversation(jobs, conversationId),
      hold: (jobId) => jobRunner.holdLlmStages(jobId),
      stop: (jobId) => jobRunner.stop(jobId),
    },
  });
  const { conversationId } = await conversations.createConversation(new Date());
  const received: HubMessage[] = [];
  await hubs.get(conversationId).subscribe(0, (message) => received.push(message));

  const say = async (text: string) => {
    await hubs.get(conversationId).confirm({ type: 'user.message', text, attachments: [] });
    talk.kick(conversationId);
  };
  const events = async (): Promise<ConversationEvent[]> =>
    (await conversations.readEvents(conversationId)).events;
  const types = async () => (await events()).map((e) => e.type);
  const submit = async (stopConditions: StopConditions, batchSize = 1) => {
    const spec = await jobs.createJob(
      {
        kind: 'auto',
        request: '海辺の少女',
        stopConditions,
        batchSize,
        conversationId,
        turn: 1,
      },
      { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
      new Date(),
    );
    return spec.jobId;
  };
  return {
    conversations,
    hubs,
    jobs,
    llm,
    backend,
    jobRunner,
    talk,
    conversationId,
    received,
    say,
    events,
    types,
    submit,
    openTool,
    toolEntered,
  };
}

const stoppedReason = async (
  jobs: FsJobStore | { readState: FsJobStore['readState'] },
  id: string,
) => {
  const state: JobState = await jobs.readState(id);
  return state.status === 'stopped' ? state.reason.kind : state.status;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
/** 待ちが解けなかったときに、試験が止まり続けず赤になるように、時間で打ち切る */
const within = <T>(promise: Promise<T>, ms = 3000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('時間切れ')), ms)),
  ]);
const textOf = (call: TalkStepCall | undefined) =>
  (call?.messages.user ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

describe('a human message while the job of the conversation is running', () => {
  it('aborts the judge call, adopts the chosen image as a favorite, and passes the instruction to the next think', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, llm, submit, types, received, events } =
      await setup({
        judge: judging.script,
        talk: (_call, n) =>
          n === 0
            ? {
                text: '採ります。',
                toolCalls: [
                  { name: 'adopt_image', input: { iteration: 1, index: 1 } },
                  { name: 'revise_drawing', input: { instruction: '夕焼けにして' } },
                ],
              }
            : { text: 'わかりました' },
      });
    const jobId = await submit({ aiJudgement: false, maxIterations: 2 }, 2);
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await say('これでいいから、次は夕焼けにして');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    // 見る役の呼び出しは abort され、その回は見る役を通らず adopted.json で済む
    expect(judging.signals[0]!.aborted).toBe(true);
    expect(await jobs.readStage(jobId, 1, 'judge')).toBeUndefined();
    expect(await jobs.readAdopted(jobId, 1)).toMatchObject({
      by: 'human',
      image: { iteration: 1, index: 1 },
      score: 1,
    });
    expect(await jobs.readSelection(jobId, '1-1')).toMatchObject({ verdict: 'favorite' });
    expect((await jobs.readState(jobId)).carry?.best).toMatchObject({
      iteration: 1,
      imageIndex: 1,
      score: 1,
    });
    // 次の回の考える役に、指示が入る
    const thinkCalls = llm.calls.filter((c) => c.purpose === 'think');
    expect(thinkCalls).toHaveLength(2);
    expect(JSON.stringify(thinkCalls[1]!.messages)).toContain('夕焼けにして');
    // 見る役は、abort された1回と、2回目の回の1回だけ
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(2);
    expect(await stoppedReason(jobs, jobId)).toBe('limit:iterations');
    // ツールは成功し、待ちが解けて、ジョブの段が続けて会話に出る
    expect((await events()).filter((e) => e.type === 'tool.result')).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(await types()).toContain('job.stopped');
    expect(received.some((m) => m.kind === 'live' && m.event.type === 'status')).toBe(true);
  });

  it('stops the job as adopted, and tells the conversation so, when only the choice is given', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, llm, submit, events } = await setup({
      judge: judging.script,
      talk: (_call, n) =>
        n === 0 ? { toolCalls: [{ name: 'adopt_image', input: {} }] } : { text: 'これで止めます' },
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 5 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await say('これでいい');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    expect(await stoppedReason(jobs, jobId)).toBe('adopted');
    expect(llm.calls.filter((c) => c.purpose === 'think')).toHaveLength(1);
    expect(await jobs.listGenerations(jobId)).toHaveLength(1);
    expect((await events()).find((e) => e.type === 'job.stopped')).toMatchObject({
      jobId,
      reason: { kind: 'adopted' },
    });
    expect(await jobs.readSelection(jobId, '1-0')).toMatchObject({ verdict: 'favorite' });
  });

  it('fails adopt_image as a tool failure when there is no job or no such image, and writes no favorite', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, submit, events } = await setup({
      judge: judging.script,
      talk: (_call, n) =>
        n === 0
          ? { toolCalls: [{ name: 'adopt_image', input: { iteration: 1, index: 5 } }] }
          : { text: '選べませんでした' },
    });
    // 描いている絵が無い会話
    await say('これでいい');
    await within(talk.idle(conversationId));
    expect((await events()).find((e) => e.type === 'tool.result')).toMatchObject({
      ok: false,
      summary: '描いている絵が無い',
    });

    // 絵はあるが、その画像が無い会話
    const jobId = await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));
    await say('5枚目でいい');
    await within(talk.idle(conversationId));
    const results = (await events()).filter((e) => e.type === 'tool.result');
    expect(results.at(-1)).toMatchObject({ ok: false });
    expect(await jobs.listSelections(jobId)).toEqual([]);
    expect(await jobs.listInterventions(jobId)).toEqual([]);
    judging.answer(0);
    await within(jobRunner.idle());
  });

  it('does not stop the generation in progress, and does not call interrupt()', async () => {
    const backend = new GatedBackend(true);
    const { say, talk, conversationId, jobs, jobRunner, submit, events, llm } = await setup({
      backend,
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(backend.generateSignals).toHaveLength(1));

    await say('ちょっと聞きたいんだけど');
    await within(talk.idle(conversationId));

    // 話す役のターンは、生成と並んで終わる
    expect((await events()).at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
    expect(backend.generateSignals[0]!.aborted).toBe(false);
    expect(backend.interruptCount).toBe(0);
    expect(await jobs.listGenerations(jobId)).toHaveLength(0);

    backend.openGenerate();
    await within(jobRunner.idle());

    expect(await jobs.listGenerations(jobId)).toHaveLength(1);
    expect(backend.generateSignals[0]!.aborted).toBe(false);
    expect(backend.interruptCount).toBe(0);
    expect(llm.calls.filter((c) => c.purpose === 'judge')).toHaveLength(1);
    expect(await stoppedReason(jobs, jobId)).toBe('limit:iterations');
  });

  it('streams job.paused while the job waits, and never writes it to the files', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobRunner, submit, received } = await setup({
      judge: judging.script,
      hangs: { 0: '少し考えます' },
    });
    await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await say('待って');
    await vi.waitFor(() =>
      expect(
        received.some(
          (m) => m.kind === 'live' && m.event.type === 'status' && m.event.status === 'job.paused',
        ),
      ).toBe(true),
    );
    await talk.interrupt(conversationId, 'turn');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    const dir = join(root, 'conversations', conversationId, 'events');
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(await readFile(join(dir, file), 'utf8')).not.toContain('job.paused');
    }
    expect(
      received.some((m) => m.kind === 'confirmed' && m.event.type === ('status' as never)),
    ).toBe(false);
  });

  it('releases the wait when the talk turn fails', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, submit, events } = await setup({
      judge: judging.script,
      talk: () => {
        throw new Error('LLM が落ちた');
      },
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await say('これでいい');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    expect((await events()).filter((e) => e.type === 'turn.ended')).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
    // 見る役は、abort された呼び出しとは別の新しい呼び出しで、やり直される
    expect(judging.signals).toHaveLength(2);
    expect(judging.signals[0]!.aborted).toBe(true);
    expect(judging.signals[1]!.aborted).toBe(false);
    expect(await jobs.readStage(jobId, 1, 'judge')).toBeDefined();
    expect(await stoppedReason(jobs, jobId)).toBe('limit:iterations');
  });

  it('releases the wait when the talk turn is interrupted', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, submit } = await setup({
      judge: judging.script,
      hangs: { 0: '考え中' },
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));

    await say('これでいい');
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));
    await talk.interrupt(conversationId, 'turn');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    expect(judging.signals).toHaveLength(2);
    expect(await stoppedReason(jobs, jobId)).toBe('limit:iterations');
  });
});

describe('a human message in the middle of a talk turn', () => {
  it('aborts the call, confirms the streamed text as interrupted, and reads both messages in the next turn', async () => {
    const { say, talk, conversationId, llm, events, conversations } = await setup({
      hangs: { 0: '考え中です、まず' },
      talk: () => ({ text: '了解です' }),
    });

    await say('夕焼けを描いて');
    await vi.waitFor(() => expect(llm.steps).toHaveLength(1));
    await say('やっぱり朝焼けで');
    await within(talk.idle(conversationId));

    expect(llm.steps[0]!.signal.aborted).toBe(true);
    const all = await events();
    expect(all.find((e) => e.type === 'assistant.message')).toMatchObject({
      turn: 1,
      text: '考え中です、まず',
      interrupted: true,
    });
    expect(all.filter((e) => e.type === 'turn.ended')).toEqual([
      expect.objectContaining({ turn: 1, outcome: 'interrupted' }),
      expect.objectContaining({ turn: 2, outcome: 'done' }),
    ]);
    // 新しいターンは、打ち切られたターンの発言と本文と、新しい発言を読む
    const input = textOf(llm.steps[1]);
    expect(input).toContain('夕焼けを描いて');
    expect(input).toContain('考え中です、まず');
    expect(input).toContain('やっぱり朝焼けで');
    // 打ち切った呼び出しも、会話の記録に残る
    expect(
      (await conversations.readEvents(conversationId)).events.filter(
        (e) => e.type === 'turn.started',
      ),
    ).toHaveLength(2);
  });

  it('lets a tool in progress finish, then interrupts: the job is made exactly once', async () => {
    const {
      say,
      talk,
      conversationId,
      jobs,
      jobRunner,
      llm,
      events,
      types,
      openTool,
      toolEntered,
    } = await setup({
      gateStartDrawing: true,
      talk: (_call, n) =>
        n === 0
          ? {
              text: '描きます。',
              toolCalls: [
                {
                  name: 'start_drawing',
                  input: {
                    request: '夕暮れの海辺の少女',
                    stopConditions: { aiJudgement: false, maxIterations: 1 },
                  },
                },
              ],
            }
          : { text: 'はい' },
    });

    await say('夕暮れの海辺の少女を描いて');
    await vi.waitFor(() => expect(toolEntered.value).toBe(true));
    await say('やっぱり猫も入れて');
    await tick();

    // ツールが終わるまで、ターンは打ち切られない
    expect(await types()).not.toContain('turn.ended');
    expect(await types()).not.toContain('tool.result');

    openTool();
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    const all = await events();
    const order = all.map((e) => e.type);
    expect(order.indexOf('tool.result')).toBeGreaterThan(order.indexOf('job.started'));
    expect(all.find((e) => e.type === 'tool.result')).toMatchObject({ ok: true });
    expect(all.filter((e) => e.type === 'turn.ended')).toEqual([
      expect.objectContaining({ turn: 1, outcome: 'interrupted' }),
      expect.objectContaining({ turn: 2, outcome: 'done' }),
    ]);
    expect(order.indexOf('turn.ended')).toBeGreaterThan(order.indexOf('tool.result'));
    expect(await jobs.listJobIds()).toHaveLength(1);
    // 打ち切ったターンは、ツールのあとで話す役を呼び直さない。呼ばれたのは、1ターン目の1回と2ターン目の1回
    expect(llm.steps).toHaveLength(2);
  });
});

describe('interrupting from the human', () => {
  it('scope all: ends the turn and stops the job (abort and interrupt()) while the judge runs', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, backend, submit, events } = await setup({
      judge: judging.script,
      hangs: { 0: '考え中' },
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 3 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));
    await say('待って');
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));

    const done = await talk.interrupt(conversationId, 'all');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    expect(done).toEqual({ turn: true, job: jobId });
    expect((await events()).filter((e) => e.type === 'turn.ended')).toEqual([
      expect.objectContaining({ outcome: 'interrupted' }),
    ]);
    expect(await stoppedReason(jobs, jobId)).toBe('human');
    expect(backend.interruptCount).toBe(1);
    // 止めたジョブの見る役は、やり直されない
    expect(judging.signals).toHaveLength(1);
  });

  it('scope all: stops a job that is generating, with no turn running', async () => {
    const backend = new GatedBackend(true);
    const { talk, conversationId, jobs, jobRunner, submit } = await setup({ backend });
    const jobId = await submit({ aiJudgement: false, maxIterations: 3 });
    jobRunner.kick();
    await vi.waitFor(() => expect(backend.generateSignals).toHaveLength(1));

    const done = await talk.interrupt(conversationId, 'all');
    await within(jobRunner.idle());

    expect(done).toEqual({ turn: false, job: jobId });
    expect(backend.generateSignals[0]!.aborted).toBe(true);
    expect(backend.interruptCount).toBe(1);
    expect(await stoppedReason(jobs, jobId)).toBe('human');
  });

  it('scope turn: ends only the turn, and does not touch the job while the judge runs', async () => {
    const judging = blocking(judge, (n) => n === 0);
    const { say, talk, conversationId, jobs, jobRunner, backend, submit, events } = await setup({
      judge: judging.script,
      hangs: { 0: '考え中' },
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(judging.signals).toHaveLength(1));
    await say('待って');
    await vi.waitFor(() => expect(judging.signals[0]!.aborted).toBe(true));

    const done = await talk.interrupt(conversationId, 'turn');
    await within(talk.idle(conversationId));
    await within(jobRunner.idle());

    expect(done).toEqual({ turn: true, job: undefined });
    expect((await events()).filter((e) => e.type === 'turn.ended')).toEqual([
      expect.objectContaining({ outcome: 'interrupted' }),
    ]);
    expect(backend.interruptCount).toBe(0);
    // ジョブは続き、止まるまで回る
    expect(await stoppedReason(jobs, jobId)).toBe('limit:iterations');
  });

  it('scope turn: does not touch a generation in progress', async () => {
    const backend = new GatedBackend(true);
    const { say, talk, conversationId, jobs, jobRunner, submit } = await setup({
      backend,
      hangs: { 0: '考え中' },
    });
    const jobId = await submit({ aiJudgement: false, maxIterations: 1 });
    jobRunner.kick();
    await vi.waitFor(() => expect(backend.generateSignals).toHaveLength(1));
    await say('待って');
    await tick();

    await talk.interrupt(conversationId, 'turn');
    await within(talk.idle(conversationId));
    expect(backend.generateSignals[0]!.aborted).toBe(false);
    expect(backend.interruptCount).toBe(0);

    backend.openGenerate();
    await within(jobRunner.idle());
    expect(await stoppedReason(jobs, jobId)).toBe('limit:iterations');
  });

  it('does nothing, and says so, when neither a turn nor a job is running', async () => {
    const { talk, conversationId, jobs, events } = await setup();

    expect(await talk.interrupt(conversationId, 'turn')).toEqual({ turn: false, job: undefined });
    expect(await talk.interrupt(conversationId, 'all')).toEqual({ turn: false, job: undefined });
    expect(await events()).toEqual([]);
    expect(await jobs.listJobIds()).toEqual([]);
  });
});
