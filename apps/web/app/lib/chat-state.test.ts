import type { ConversationEvent, LiveEvent } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import {
  applyConfirmed,
  applyLive,
  chatItems,
  EMPTY_CHAT_STATE,
  isRunning,
  type ChatState,
} from './chat-state';

const AT = '2026-10-09T15:30:00+09:00';
const JOB = '20261009-153112-k3f9';

type NewEvent = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, 'seq' | 'at'>
    : never
  : never;

function confirmAll(events: NewEvent[], state: ChatState = EMPTY_CHAT_STATE): ChatState {
  let seq = state.confirmed.at(-1)?.seq ?? 0;
  return events.reduce(
    (current, event) =>
      applyConfirmed(current, { ...event, seq: ++seq, at: AT } as ConversationEvent),
    state,
  );
}

const live = (state: ChatState, ...events: LiveEvent[]) => events.reduce(applyLive, state);
const kinds = (state: ChatState) => chatItems(state).map((item) => item.kind);

describe('chatItems', () => {
  it('turns each confirmed event into a log row', () => {
    const state = confirmAll([
      { type: 'user.message', text: '描いて', attachments: [] },
      { type: 'turn.started', turn: 1, messageSeqs: [1] },
      { type: 'assistant.reasoning', turn: 1, partId: 'r1', text: '指示なので描く' },
      { type: 'tool.call', turn: 1, callId: 'c1', name: 'start_drawing', input: { request: '海' } },
      { type: 'tool.result', turn: 1, callId: 'c1', ok: true, summary: 'ジョブを作った' },
      { type: 'assistant.message', turn: 1, partId: 'm1', text: '描きます', interrupted: false },
      { type: 'turn.ended', turn: 1, outcome: 'done' },
      {
        type: 'job.started',
        jobId: JOB,
        request: '海',
        stopConditions: { aiJudgement: true, maxIterations: 3 },
      },
      {
        type: 'job.think',
        jobId: JOB,
        iteration: 1,
        rationale: '夕焼けに',
        params: {},
        excluded: [],
      },
      { type: 'job.images', jobId: JOB, iteration: 1, images: [{ index: 0, seed: 1 }] },
      {
        type: 'job.judge',
        jobId: JOB,
        iteration: 1,
        images: [{ index: 0, score: 0.8, issues: [] }],
        nextChange: '',
        canStop: true,
      },
      { type: 'job.stopped', jobId: JOB, reason: { kind: 'ai', detail: '' } },
    ]);

    expect(kinds(state)).toEqual([
      'user',
      'reasoning',
      'tool',
      'assistant',
      'job-started',
      'think',
      'images',
      'judge',
      'job-stopped',
    ]);
  });

  it('shows a tool as running until its result, then as done with the summary', () => {
    const called = confirmAll([
      { type: 'tool.call', turn: 1, callId: 'c1', name: 'list_capabilities', input: {} },
    ]);
    expect(chatItems(called)).toMatchObject([{ kind: 'tool', state: 'running' }]);

    const done = confirmAll(
      [{ type: 'tool.result', turn: 1, callId: 'c1', ok: false, summary: '繋がらない' }],
      called,
    );

    expect(chatItems(done)).toMatchObject([
      { kind: 'tool', state: 'error', summary: '繋がらない' },
    ]);
  });

  it('lays the judge scores onto the images of the same iteration', () => {
    const state = confirmAll([
      {
        type: 'job.images',
        jobId: JOB,
        iteration: 2,
        images: [
          { index: 0, seed: 5 },
          { index: 1, seed: 6 },
        ],
      },
      {
        type: 'job.judge',
        jobId: JOB,
        iteration: 2,
        images: [{ index: 1, score: 0.4, issues: ['手が崩れている'] }],
        nextChange: '手を隠す',
        canStop: false,
      },
    ]);

    expect(chatItems(state)[0]).toMatchObject({
      kind: 'images',
      images: [
        { index: 0, seed: 5 },
        { index: 1, score: 0.4, issues: ['手が崩れている'] },
      ],
    });
  });

  it('offers to resend the message whose turn was cut off', () => {
    const state = confirmAll([
      { type: 'user.message', text: '続けて', attachments: [] },
      { type: 'turn.started', turn: 1, messageSeqs: [1] },
      { type: 'turn.ended', turn: 1, outcome: 'interrupted', reason: 'プロセスの再起動' },
    ]);

    expect(chatItems(state)).toMatchObject([
      { kind: 'user', text: '続けて', turnInterrupted: 'プロセスの再起動' },
    ]);
  });

  it('stops offering to resend once the same message has been sent again', () => {
    const cut = confirmAll([
      { type: 'user.message', text: '続けて', attachments: [] },
      { type: 'turn.started', turn: 1, messageSeqs: [1] },
      { type: 'turn.ended', turn: 1, outcome: 'interrupted', reason: 'プロセスの再起動' },
      { type: 'user.message', text: '別の話', attachments: [] },
    ]);
    const resent = confirmAll([{ type: 'user.message', text: '続けて', attachments: [] }], cut);

    expect(chatItems(cut)[0]).not.toHaveProperty('resent');
    expect(chatItems(resent)[0]).toMatchObject({
      turnInterrupted: 'プロセスの再起動',
      resent: true,
    });
  });

  it('does not add the same confirmed event twice', () => {
    const once = confirmAll([{ type: 'user.message', text: '一度だけ', attachments: [] }]);
    const again = applyConfirmed(once, once.confirmed[0]!);

    expect(chatItems(again)).toHaveLength(1);
  });
});

describe('streaming parts', () => {
  it('grows the text from deltas and replaces it with the confirmed message of the same part', () => {
    const streaming = live(
      EMPTY_CHAT_STATE,
      { type: 'delta.text', partId: 'm1', turn: 1, text: '描き' },
      { type: 'delta.text', partId: 'm1', turn: 1, text: 'ます' },
    );
    expect(chatItems(streaming)).toMatchObject([
      { kind: 'assistant', text: '描きます', streaming: true },
    ]);

    const confirmed = confirmAll(
      [
        {
          type: 'assistant.message',
          turn: 1,
          partId: 'm1',
          text: '描きます。',
          interrupted: false,
        },
      ],
      streaming,
    );

    expect(chatItems(confirmed)).toMatchObject([
      { kind: 'assistant', text: '描きます。', streaming: false },
    ]);
  });

  it('replaces the text with the snapshot sent when the subscription starts again', () => {
    const before = live(EMPTY_CHAT_STATE, {
      type: 'delta.text',
      partId: 'm1',
      turn: 1,
      text: '描き',
    });
    const reconnected = live(
      before,
      { type: 'delta.text', partId: 'm1', turn: 1, text: '描きます', replace: true },
      { type: 'delta.text', partId: 'm1', turn: 1, text: '。' },
    );

    expect(chatItems(reconnected)).toMatchObject([{ kind: 'assistant', text: '描きます。' }]);
  });

  it('ignores a delta that arrives after its part was confirmed', () => {
    const confirmed = confirmAll([
      { type: 'assistant.message', turn: 1, partId: 'm1', text: '済み', interrupted: true },
    ]);
    const late = live(confirmed, { type: 'delta.text', partId: 'm1', turn: 1, text: '遅れた増分' });

    expect(chatItems(late)).toMatchObject([{ kind: 'assistant', text: '済み', interrupted: true }]);
  });

  it('streams the thinker reasoning and folds it into the confirmed think of that iteration', () => {
    const streaming = live(EMPTY_CHAT_STATE, {
      type: 'delta.reasoning',
      partId: 'job-think-1',
      source: { role: 'think', jobId: JOB, iteration: 1 },
      text: '空の色を',
    });
    expect(chatItems(streaming)).toMatchObject([
      { kind: 'reasoning', label: '考える役の思考（1 回目）', streaming: true },
    ]);

    const confirmed = confirmAll(
      [
        {
          type: 'job.think',
          jobId: JOB,
          iteration: 1,
          reasoning: '空の色を抑える',
          rationale: '彩度を下げる',
          params: {},
          excluded: [],
        },
      ],
      streaming,
    );

    expect(chatItems(confirmed)).toMatchObject([
      { kind: 'reasoning', text: '空の色を抑える', streaming: false },
      { kind: 'think', rationale: '彩度を下げる' },
    ]);
  });

  it('drops the unfinished talk parts when the turn ends', () => {
    const streaming = live(EMPTY_CHAT_STATE, {
      type: 'delta.text',
      partId: 'm1',
      turn: 1,
      text: '途中',
    });
    const ended = confirmAll(
      [{ type: 'turn.ended', turn: 1, outcome: 'error', reason: 'LLM に繋がらない' }],
      streaming,
    );

    expect(kinds(ended)).toEqual(['turn-error']);
  });

  it('shows the generation progress until the images of that iteration arrive', () => {
    const progressing = live(EMPTY_CHAT_STATE, {
      type: 'generation.progress',
      jobId: JOB,
      iteration: 1,
      progress: 0.5,
      step: 10,
      steps: 20,
    });
    expect(chatItems(progressing)).toMatchObject([{ kind: 'progress', progress: 0.5 }]);

    const done = confirmAll(
      [{ type: 'job.images', jobId: JOB, iteration: 1, images: [] }],
      progressing,
    );

    expect(kinds(done)).toEqual(['images']);
  });

  it('keeps the latest status at the end until the turn moves on', () => {
    const waiting = live(EMPTY_CHAT_STATE, { type: 'status', status: 'waiting-llm' });
    expect(kinds(waiting)).toEqual(['status']);

    const answering = live(waiting, { type: 'delta.text', partId: 'm1', turn: 1, text: 'は' });

    expect(kinds(answering)).toEqual(['assistant']);
  });
});

describe('isRunning', () => {
  it('is running while a turn is open or a job has not stopped', () => {
    const turn = confirmAll([{ type: 'turn.started', turn: 1, messageSeqs: [] }]);
    expect(isRunning(turn)).toBe(true);

    const job = confirmAll(
      [
        { type: 'turn.ended', turn: 1, outcome: 'done' },
        { type: 'job.started', jobId: JOB, request: '海', stopConditions: { aiJudgement: true } },
      ],
      turn,
    );
    expect(isRunning(job)).toBe(true);

    const stopped = confirmAll(
      [{ type: 'job.stopped', jobId: JOB, reason: { kind: 'human', detail: '' } }],
      job,
    );
    expect(isRunning(stopped)).toBe(false);
  });
});
