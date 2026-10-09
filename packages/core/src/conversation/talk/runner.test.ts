import { describe, expect, it } from 'vitest';

import type { JobStore } from '../../job/store.js';
import type { TalkStepCall } from '../../llm/port.js';
import { basicPermissions } from '../../loop/iteration-permissions.js';
import type { Permissions } from '../../permissions/permission.js';
import { MemoryConversationStore } from '../../testing/memory-conversation-store.js';
import { ScriptedLlm, type TalkScript } from '../../testing/scripted-llm.js';
import { StubBackend } from '../../testing/stub-backend.js';
import { ConversationHubs } from '../hub.js';
import { DEFAULT_TALK_LIMITS, type TalkLimits } from './limits.js';
import { TalkRunner } from './runner.js';
import { createReadOnlyTools } from './tools.js';

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
    llm: () => (options.llm === false ? undefined : llm),
    tools: createReadOnlyTools({ backend, permissions: async () => permissions, jobs: noJobs }),
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
