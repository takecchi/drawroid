import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { JobStore } from '../../job/store.js';
import type { LlmPort, TalkStepCall, TalkStepPart } from '../../llm/port.js';
import { basicPermissions } from '../../loop/iteration-permissions.js';
import type { Permissions } from '../../permissions/permission.js';
import { MemoryConversationStore } from '../../testing/memory-conversation-store.js';
import { ScriptedLlm, type TalkScript } from '../../testing/scripted-llm.js';
import { StubBackend } from '../../testing/stub-backend.js';
import { ConversationHubs, type HubMessage } from '../hub.js';
import { DEFAULT_TALK_LIMITS, type TalkLimits } from './limits.js';
import { TalkRunner, REPEATED_TOOL_CALL_REASON, TOOL_THREW_PREFIX } from './runner.js';
import { createReadOnlyTools, type TalkTool } from './tools.js';

const now = () => new Date('2026-10-09T08:00:00.000Z');
const noJobs = {
  readState: () => Promise.reject(new Error('この試験では使わない')),
} as unknown as JobStore;

async function setup(
  talk: TalkScript,
  options: {
    limits?: Partial<TalkLimits>;
    permissions?: Permissions;
    llm?: boolean;
    loras?: { name: string; label?: string }[];
    /** 台本の LLM を包んで、出し直しなど台本で書けない流れを作る */
    wrap?: (scripted: ScriptedLlm) => LlmPort;
    /** 副作用の無いツールの後ろに足すツール */
    extraTools?: TalkTool[];
  } = {},
) {
  const store = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store, now });
  const { conversationId } = await store.createConversation(now());
  const llm = new ScriptedLlm({}, { talk });
  const backend = new StubBackend({
    candidates: {
      lora: options.loras ?? [
        { name: 'miku_v2', label: '初音ミク' },
        { name: 'rin_v1', label: '鏡音リン' },
      ],
    },
  });
  const permissions =
    options.permissions ??
    ({
      ...basicPermissions({ width: 1024, height: 1024 }),
      loras: { mode: 'auto' },
    } as Permissions);
  const runner = new TalkRunner({
    store,
    hubs,
    llm: () => (options.llm === false ? undefined : (options.wrap?.(llm) ?? llm)),
    tools: [
      ...createReadOnlyTools({ backend, permissions: async () => permissions, jobs: noJobs }),
      ...(options.extraTools ?? []),
    ],
    limits: async () => ({ ...DEFAULT_TALK_LIMITS, ...options.limits }),
    now,
  });
  const say = async (text: string) => {
    await hubs.get(conversationId).confirm({ type: 'user.message', text, attachments: [] });
    runner.kick(conversationId);
    await runner.idle(conversationId);
  };
  const events = async () => (await store.readEvents(conversationId)).events;
  const types = async () => (await events()).map((e) => e.type);
  return { store, hubs, llm, runner, conversationId, say, events, types };
}

const textOf = (call: TalkStepCall | undefined) =>
  (call?.messages.user ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

describe('TalkRunner', () => {
  it('answers "what can you do?" with text only, starting no job', async () => {
    const { say, types, events, store, conversationId } = await setup(() => ({
      text: '依頼の文から絵を描いて、回を重ねて直せます。',
    }));
    await say('何ができますか？');

    expect(await types()).toEqual([
      'user.message',
      'turn.started',
      'assistant.message',
      'turn.ended',
    ]);
    expect((await events()).at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
    expect((await events()).some((e) => e.type === 'job.started')).toBe(false);
    // 話す役の呼び出しは、会話の llm-calls に記録する
    expect(store.llmCalls.get(conversationId)).toEqual([
      expect.objectContaining({
        role: 'talk',
        purpose: 'talk',
        jobId: null,
        outcome: expect.objectContaining({ ok: true }),
      }),
    ]);
  });

  it('looks up the candidates to answer "can you draw this character?", and uses the result', async () => {
    const { say, types, events, llm } = await setup((call, n) =>
      n === 0
        ? {
            text: '調べます。',
            toolCalls: [{ name: 'search_candidates', input: { kind: 'lora', query: 'ミク' } }],
          }
        : {
            text: textOf(call).includes('miku_v2')
              ? 'miku_v2 の LoRA があるので描けます。'
              : '分かりません',
          },
    );
    await say('初音ミク描けますか？');

    expect(await types()).toEqual([
      'user.message',
      'turn.started',
      'assistant.message',
      'tool.call',
      'tool.result',
      'assistant.message',
      'turn.ended',
    ]);
    const all = await events();
    expect(all.at(-2)).toMatchObject({
      type: 'assistant.message',
      text: 'miku_v2 の LoRA があるので描けます。',
    });
    expect(all.find((e) => e.type === 'tool.result')).toMatchObject({ ok: true });
    expect(all.some((e) => e.type === 'job.started')).toBe(false);
    // 2つ目のステップの入力に、ツールの結果が載る（鏡音リンは当たらない）
    expect(textOf(llm.steps[1])).toContain('miku_v2');
    expect(textOf(llm.steps[1])).not.toContain('rin_v1');
  });

  it('does not put the thinking into the next input, in the same turn or the next one', async () => {
    const { say, llm } = await setup((_call, n) =>
      n === 0
        ? { reasoning: '秘密の思考', toolCalls: [{ name: 'describe_backend', input: {} }] }
        : { reasoning: '別の秘密', text: 'はい' },
    );
    await say('何が使えますか？');
    await say('ありがとう');

    expect(llm.steps).toHaveLength(3);
    for (const step of llm.steps.slice(1)) {
      expect(textOf(step)).not.toContain('秘密');
    }
  });

  it('clips a long tool result in the input and records the clipping in the LLM call record', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `lora_${String(i).padStart(2, '0')}_${'x'.repeat(30)}`,
    }));
    const { say, store, conversationId } = await setup(
      (_call, n) =>
        n === 0
          ? { toolCalls: [{ name: 'search_candidates', input: { kind: 'lora' } }] }
          : { text: 'たくさんあります' },
      { limits: { toolResultChars: 50, candidates: { maxCount: 50, maxSize: 5000 } }, loras: many },
    );
    await say('LoRA は何がある？');
    const second = store.llmCalls.get(conversationId)?.[1];
    expect(second?.budget.notes).toContainEqual(
      expect.objectContaining({ kind: 'clipped', section: 'step[0].result', to: 50 }),
    );
  });

  it('closes the turn with a reply on the final step when the model keeps calling tools', async () => {
    const { say, events, llm } = await setup(
      (call) =>
        call.tools.length === 0
          ? { text: 'ここまでの結果で答えます' }
          : { toolCalls: [{ name: 'describe_backend', input: {} }] },
      { limits: { maxSteps: 3 } },
    );
    await say('調べて');

    expect(llm.steps).toHaveLength(3);
    expect(llm.steps[2]?.tools).toEqual([]);
    expect((await events()).at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
  });

  it('runs a call repeated with the same arguments only once, then has the model answer without tools', async () => {
    const { say, events, llm } = await setup(
      (call) =>
        call.tools.length === 0
          ? { text: '調べた結果で答えます' }
          : { toolCalls: [{ name: 'search_candidates', input: { kind: 'lora', query: 'ミク' } }] },
      { limits: { maxSteps: 6 } },
    );
    await say('ミクの LoRA ある？');

    const all = await events();
    const results = all.flatMap((e) => (e.type === 'tool.result' ? [e] : []));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true });
    // 画面はこの形（頭の言葉 + 断りの文）を見て、人の言葉に置き換える
    expect(results[1]).toMatchObject({
      ok: false,
      summary: `${TOOL_THREW_PREFIX}${REPEATED_TOOL_CALL_REASON}`,
    });
    // 繰り返したら、次のステップはツールを渡さない。上限（6）まで回さない
    expect(llm.steps).toHaveLength(3);
    expect(llm.steps[2]?.tools).toEqual([]);
    expect(all.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
  });

  it('treats the same arguments in another key order as the same call', async () => {
    const { say, events } = await setup((_call, n) =>
      n === 0
        ? { toolCalls: [{ name: 'search_candidates', input: { kind: 'lora', query: 'ミク' } }] }
        : n === 1
          ? { toolCalls: [{ name: 'search_candidates', input: { query: 'ミク', kind: 'lora' } }] }
          : { text: '答えます' },
    );
    await say('ミクの LoRA ある？');

    const results = (await events()).flatMap((e) => (e.type === 'tool.result' ? [e.ok] : []));
    expect(results).toEqual([true, false]);
  });

  /** 走った回数を数えるツール。fail なら、走ったあとで投げる */
  const countingTool = (fail: boolean) => {
    const counter = { runs: 0 };
    const tool: TalkTool = {
      name: 'note_down',
      description: '試験用。メモを書き留める',
      inputSchema: z.object({ text: z.string() }),
      run: async () => {
        counter.runs += 1;
        if (fail) throw new Error('書き留められなかった');
        return { ok: true, result: '書き留めた', summary: '書き留めた' };
      },
    };
    return { tool, counter };
  };

  it('runs a call only once when one step asks for it twice', async () => {
    const { tool, counter } = countingTool(false);
    const { say, events } = await setup(
      (_call, n) =>
        n === 0
          ? {
              toolCalls: [
                { name: 'note_down', input: { text: '海辺' } },
                { name: 'note_down', input: { text: '海辺' } },
              ],
            }
          : { text: '書き留めました' },
      { extraTools: [tool] },
    );
    await say('メモして');

    expect(counter.runs).toBe(1);
    const results = (await events()).flatMap((e) => (e.type === 'tool.result' ? [e] : []));
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ summary: expect.stringMatching(/同じ引数/) });
  });

  it('does not run a call again after it ran and failed, and has the model answer without tools', async () => {
    const { tool, counter } = countingTool(true);
    const { say, events, llm } = await setup(
      (call) =>
        call.tools.length === 0
          ? { text: '書き留められませんでした' }
          : { toolCalls: [{ name: 'note_down', input: { text: '海辺' } }] },
      { extraTools: [tool], limits: { maxSteps: 6 } },
    );
    await say('メモして');

    expect(counter.runs).toBe(1);
    const results = (await events()).flatMap((e) => (e.type === 'tool.result' ? [e] : []));
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: false, summary: expect.stringMatching(/同じ引数/) });
    expect(llm.steps[2]?.tools).toEqual([]);
  });

  it('runs the same tool again when the arguments differ', async () => {
    const { say, events, llm } = await setup((_call, n) =>
      n < 3
        ? {
            toolCalls: [
              {
                name: 'search_candidates',
                input: { kind: 'lora', query: ['ミク', '初音', 'miku'][n]! },
              },
            ],
          }
        : { text: '答えます' },
    );
    await say('ミクの LoRA ある？');

    const results = (await events()).flatMap((e) => (e.type === 'tool.result' ? [e.ok] : []));
    expect(results).toEqual([true, true, true]);
    expect(llm.steps[3]?.tools.length).toBeGreaterThan(0);
  });

  it('closes the turn as an error when the final step gives no reply', async () => {
    const { say, events } = await setup(
      (call) =>
        call.tools.length === 0 ? {} : { toolCalls: [{ name: 'describe_backend', input: {} }] },
      { limits: { maxSteps: 2 } },
    );
    await say('調べて');
    expect((await events()).at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'error' });
  });

  it('closes the turn as an error, with the reason, when a tool call fails the schema', async () => {
    const { say, events } = await setup(() => ({
      toolCalls: [{ name: 'search_candidates', input: { kind: 'nope' } }],
    }));
    await say('LoRA ある？');
    expect((await events()).at(-1)).toMatchObject({
      type: 'turn.ended',
      outcome: 'error',
      reason: expect.stringContaining('search_candidates'),
    });
  });

  it('searches only the candidates the permissions allow', async () => {
    const off = {
      ...basicPermissions({ width: 1024, height: 1024 }),
      loras: { mode: 'off' },
    } as Permissions;
    const { say, llm } = await setup(
      (call, n) =>
        n === 0
          ? { toolCalls: [{ name: 'search_candidates', input: { kind: 'lora', query: '' } }] }
          : { text: textOf(call) },
      { permissions: off },
    );
    await say('LoRA ある？');
    expect(textOf(llm.steps[1])).toContain('許可の設定で使わない');
    expect(textOf(llm.steps[1])).not.toContain('miku_v2');

    const narrowed = {
      ...basicPermissions({ width: 1024, height: 1024 }),
      loras: { mode: 'auto', choices: ['rin_v1'] },
    } as Permissions;
    const second = await setup(
      (call, n) =>
        n === 0
          ? { toolCalls: [{ name: 'search_candidates', input: { kind: 'lora' } }] }
          : { text: textOf(call) },
      { permissions: narrowed },
    );
    await second.say('LoRA ある？');
    expect(textOf(second.llm.steps[1])).toContain('rin_v1');
    expect(textOf(second.llm.steps[1])).not.toContain('miku_v2');
  });

  it('interrupts the turn for the messages that arrived during it, and reads them together in the next turn', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { runner, hubs, conversationId, events, llm } = await setup(async (_call, n) => {
      if (n === 0) await gate;
      return { text: `返答 ${n}` };
    });
    const hub = hubs.get(conversationId);
    await hub.confirm({ type: 'user.message', text: '1つ目', attachments: [] });
    runner.kick(conversationId);
    await hub.confirm({ type: 'user.message', text: '2つ目', attachments: [] });
    runner.kick(conversationId);
    await hub.confirm({ type: 'user.message', text: '3つ目', attachments: [] });
    runner.kick(conversationId);
    // 発言を受けて、LLM の出力を待っているターンが打ち切られるのを待つ
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    await runner.idle(conversationId);

    const all = await events();
    const seqOf = (text: string) =>
      all.find((e) => e.type === 'user.message' && e.text === text)?.seq;
    const started = all.filter((e) => e.type === 'turn.started');
    expect(started.map((e) => (e.type === 'turn.started' ? e.messageSeqs : []))).toEqual([
      [seqOf('1つ目')],
      [seqOf('2つ目'), seqOf('3つ目')],
    ]);
    expect(
      all
        .filter((e) => e.type === 'turn.ended')
        .map((e) => (e.type === 'turn.ended' ? e.outcome : '')),
    ).toEqual(['interrupted', 'done']);
    // 1つ目のターンは、LLM を呼ぶ前に打ち切られた。呼ばれたのは2つ目のターンの1回だけ
    expect(llm.steps).toHaveLength(1);
  });

  it('confirms the thinking and the text that were streaming when a message interrupted the turn', async () => {
    let streaming: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (streaming = resolve));
    let calls = 0;
    const { runner, hubs, conversationId, events } = await setup(() => ({ text: 'はい' }), {
      // 1回目の呼び出しは、思考と本文を少し流したところで、abort されるまで返らない
      wrap: (scripted) => ({
        describe: (role) => scripted.describe(role),
        generateStructured: (call) => scripted.generateStructured(call),
        async *streamStep(call: TalkStepCall): AsyncIterable<TalkStepPart> {
          calls += 1;
          if (calls > 1) {
            yield* scripted.streamStep(call);
            return;
          }
          yield { type: 'reasoning-delta', text: '海辺を' };
          yield { type: 'text-delta', text: '描き' };
          streaming?.();
          await new Promise<never>((_, reject) =>
            call.signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('呼び手が止めた'), { name: 'AbortError' })),
              { once: true },
            ),
          );
        },
      }),
    });
    const hub = hubs.get(conversationId);
    await hub.confirm({ type: 'user.message', text: '描いて', attachments: [] });
    runner.kick(conversationId);
    await started;
    await hub.confirm({ type: 'user.message', text: 'やっぱり猫', attachments: [] });
    runner.kick(conversationId);
    await runner.idle(conversationId);

    const all = await events();
    // 中断の時点で流れていた思考と本文は、どちらもファイルに確定する（本文は途中で止まった印つき）
    expect(all.find((e) => e.type === 'assistant.reasoning' && e.turn === 1)).toMatchObject({
      text: '海辺を',
    });
    expect(all.find((e) => e.type === 'assistant.message' && e.turn === 1)).toMatchObject({
      text: '描き',
      interrupted: true,
    });
    // あとから開いた画面には、確定した思考と本文だけが届き、途中の写しは残らない
    const late: HubMessage[] = [];
    await hub.subscribe(0, (message) => late.push(message));
    expect(late.some((m) => m.kind === 'live' && m.event.type === 'delta.reasoning')).toBe(false);
    expect(late.some((m) => m.kind === 'live' && m.event.type === 'delta.text')).toBe(false);
  });

  it('numbers the turns 1, 2, 3 across messages', async () => {
    const { say, events } = await setup(() => ({ text: 'はい' }));
    await say('1つ目');
    await say('2つ目');
    await say('3つ目');

    const turns = (await events()).flatMap((e) => (e.type === 'turn.started' ? [e.turn] : []));
    expect(turns).toEqual([1, 2, 3]);
  });

  it('streams the reply once: the deltas add up to the confirmed message', async () => {
    const { say, events, hubs, conversationId } = await setup(() => ({
      reasoning: '考える',
      text: '描けます',
    }));
    const live: HubMessage[] = [];
    await hubs.get(conversationId).subscribe(0, (message) => live.push(message));
    await say('描ける？');

    // 画面は増分を足して写しを作る。replace のときは写しを置き換える
    let copy = '';
    for (const message of live) {
      if (message.kind === 'live' && message.event.type === 'delta.text') {
        copy = message.event.replace === true ? message.event.text : copy + message.event.text;
      }
    }
    const confirmed = (await events()).find((e) => e.type === 'assistant.message');
    expect(confirmed).toMatchObject({ text: '描けます' });
    expect(copy).toBe('描けます');
  });

  it('drops the tool calls of a response that was retried', async () => {
    const { say, events } = await setup(() => ({}), {
      // 1つ目の応答はツールを呼んだあとに出し直しになり、出し直しの応答は本文だけ
      wrap: (scripted) => ({
        describe: (role) => scripted.describe(role),
        generateStructured: (call) => scripted.generateStructured(call),
        async *streamStep(): AsyncIterable<TalkStepPart> {
          yield { type: 'tool-call', callId: 'c1', name: 'describe_backend', input: {} };
          yield { type: 'retry', reason: '引数が合わない' };
          yield { type: 'text-delta', text: '出し直した返答' };
          yield { type: 'finish', attempts: [] };
        },
      }),
    });
    await say('何ができる？');

    const all = await events();
    expect(all.some((e) => e.type === 'tool.call')).toBe(false);
    expect(all.find((e) => e.type === 'assistant.message')).toMatchObject({
      text: '出し直した返答',
    });
    expect(all.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'done' });
  });

  it('puts the preface text on the first tool of a step only', async () => {
    const { say, llm } = await setup((_call, n) =>
      n === 0
        ? {
            text: 'まず調べます。',
            toolCalls: [
              { name: 'describe_backend', input: {} },
              { name: 'drawing_status', input: {} },
            ],
          }
        : { text: '答えます' },
    );
    await say('調べて');

    const next = textOf(llm.steps[1]);
    expect(next).toContain('ツール describe_backend');
    expect(next).toContain('ツール drawing_status');
    expect(next.split('まず調べます。')).toHaveLength(2);
  });

  it('closes the turn as an error when no LLM is set up', async () => {
    const { say, events } = await setup(() => ({ text: 'x' }), { llm: false });
    await say('こんにちは');
    expect((await events()).at(-1)).toMatchObject({
      type: 'turn.ended',
      outcome: 'error',
      reason: expect.stringContaining('LLM が未設定'),
    });
  });
});
