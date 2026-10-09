import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_WINDOW } from '../../loop/budget.js';
import type { ConversationEvent } from '../events.js';
import { buildTalkInput } from './input.js';
import { DEFAULT_TALK_LIMITS } from './limits.js';

const at = '2026-10-09T00:00:00.000Z';
let seq = 0;
const user = (text: string): ConversationEvent => ({
  type: 'user.message',
  text,
  attachments: [],
  seq: ++seq,
  at,
});
const assistant = (turn: number, text: string): ConversationEvent => ({
  type: 'assistant.message',
  turn,
  partId: `t${turn}`,
  text,
  interrupted: false,
  seq: ++seq,
  at,
});
const reasoning = (turn: number, text: string): ConversationEvent => ({
  type: 'assistant.reasoning',
  turn,
  partId: `r${turn}`,
  text,
  seq: ++seq,
  at,
});

function textOf(messages: ReturnType<typeof buildTalkInput>): string {
  return messages.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** n ターンぶんの会話。どのターンにも長い発言・長い返答・思考がある */
function conversation(turns: number): ConversationEvent[] {
  seq = 0;
  return Array.from({ length: turns }, (_, i) => [
    user(`${i} 回目の発言。${'あ'.repeat(2000)}`),
    reasoning(i + 1, `思考 ${i}`),
    assistant(i + 1, `${i} 回目の返答。${'い'.repeat(2000)}`),
  ]).flat();
}

describe('buildTalkInput', () => {
  it('stays within the input limit after a conversation of 100 turns', () => {
    const events = [...conversation(100), user('最後の発言')];
    const messages = buildTalkInput({
      events,
      messageSeqs: [seq],
      steps: [],
      final: false,
      limits: DEFAULT_TALK_LIMITS,
      window: DEFAULT_MODEL_WINDOW,
    });
    expect(messages.report.estimatedInputTokens).toBeLessThanOrEqual(
      messages.report.inputTokenLimit,
    );
    // 100 ターンと 30 ターンで、入力の大きさが変わらない（件数と文字数で締めている。発言の番号の桁はそろえてある）
    const thirty = buildTalkInput({
      events: [...conversation(30), user('最後の発言')],
      messageSeqs: [seq],
      steps: [],
      final: false,
      limits: DEFAULT_TALK_LIMITS,
      window: DEFAULT_MODEL_WINDOW,
    });
    expect(messages.report.estimatedInputTokens).toBe(thirty.report.estimatedInputTokens);
    expect(messages.report.notes).toContainEqual(
      expect.objectContaining({ kind: 'dropped', section: 'messages' }),
    );
  });

  it('puts the text of an interrupted turn into the input, marked as cut off', () => {
    const cut: ConversationEvent = {
      ...assistant(1, '考え中です、まず'),
      interrupted: true,
    } as ConversationEvent;
    const messages = buildTalkInput({
      events: [user('夕焼けを描いて'), cut, user('やっぱり朝焼けで')],
      messageSeqs: [seq],
      steps: [],
      final: false,
      limits: DEFAULT_TALK_LIMITS,
      window: DEFAULT_MODEL_WINDOW,
    });

    const text = textOf(messages);
    expect(text).toContain('夕焼けを描いて');
    expect(text).toContain('話す役（途中で打ち切られた）: 考え中です、まず');
    expect(text).toContain('やっぱり朝焼けで');
  });

  it('never puts the thinking into the input', () => {
    seq = 0;
    const events = [
      user('描けますか'),
      reasoning(1, '秘密の思考'),
      assistant(1, '描けます'),
      user('お願い'),
    ];
    const text = textOf(
      buildTalkInput({
        events,
        messageSeqs: [4],
        steps: [{ text: '', tool: { name: 'search_candidates', input: {}, result: '結果' } }],
        final: false,
        limits: DEFAULT_TALK_LIMITS,
        window: DEFAULT_MODEL_WINDOW,
      }),
    );
    expect(text).not.toContain('秘密の思考');
    expect(text).toContain('人間: 描けますか');
    expect(text).toContain('話す役: 描けます');
  });

  it('keeps every message to answer in this turn, even outside the recent ones', () => {
    seq = 0;
    const events = [
      user('ずっと前の発言'),
      ...conversation(30).map((e) => ({ ...e, seq: e.seq + 1 })),
    ];
    const text = textOf(
      buildTalkInput({
        events,
        messageSeqs: [1],
        steps: [],
        final: false,
        limits: { ...DEFAULT_TALK_LIMITS, recentMessages: 4 },
        window: DEFAULT_MODEL_WINDOW,
      }),
    );
    expect(text).toContain('ずっと前の発言');
  });

  it('clips a long tool result and records that it did', () => {
    seq = 0;
    const messages = buildTalkInput({
      events: [user('LoRA ある？')],
      messageSeqs: [1],
      steps: [
        {
          text: '調べます',
          tool: { name: 'search_candidates', input: { kind: 'lora' }, result: 'x'.repeat(5000) },
        },
      ],
      final: false,
      limits: { ...DEFAULT_TALK_LIMITS, toolResultChars: 100 },
      window: DEFAULT_MODEL_WINDOW,
    });
    expect(messages.report.notes).toContainEqual({
      kind: 'clipped',
      section: 'step[0].result',
      from: 5000,
      to: 100,
    });
    expect(textOf(messages)).not.toContain('x'.repeat(101));
  });

  it('tells the model to answer without tools on the final step', () => {
    seq = 0;
    const text = textOf(
      buildTalkInput({
        events: [user('こんにちは')],
        messageSeqs: [1],
        steps: [],
        final: true,
        limits: DEFAULT_TALK_LIMITS,
        window: DEFAULT_MODEL_WINDOW,
      }),
    );
    expect(text).toContain('ツールは使わず');
  });
});
