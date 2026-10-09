// 話す役の1ターンが、会話を頭から全部読まずに末尾から要る分だけ読んでも、未読の発言・ターンの番号・会話のジョブ・
// 話す役への入力が、全部読んだときと同じになることを見る試験。読む量が会話の長さに比例しないことも見る
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_WINDOW } from '../../loop/budget.js';
import { MemoryConversationStore } from '../../testing/memory-conversation-store.js';
import type { ConversationEvent, NewConversationEvent } from '../events.js';
import { buildTalkInput } from './input.js';
import { DEFAULT_TALK_LIMITS, type TalkLimits } from './limits.js';
import { TalkWindowReader } from './window.js';

const now = new Date('2026-10-09T09:00:00.000Z');

/** 読んだイベントの数を数える置き場所 */
class CountingStore extends MemoryConversationStore {
  read = 0;
  override async readEventsBefore(
    conversationId: string,
    options: { before?: number; limit: number },
  ): Promise<ConversationEvent[]> {
    const events = await super.readEventsBefore(conversationId, options);
    this.read += events.length;
    return events;
  }
}

async function conversation() {
  const store = new CountingStore();
  const { conversationId } = await store.createConversation(now);
  const add = (event: NewConversationEvent) => store.appendEvent(conversationId, event, now);
  let turn = 0;
  /** 人間が1回話し、話す役が1ターンで答える */
  const round = async (text: string) => {
    const message = await add({ type: 'user.message', text, attachments: [] });
    turn += 1;
    await add({ type: 'turn.started', turn, messageSeqs: [message.seq] });
    await add({ type: 'assistant.message', turn, partId: `p${turn}`, text: `${text} への返答` });
    await add({ type: 'turn.ended', turn, outcome: 'done' });
  };
  const job = (jobId: string) =>
    add({
      type: 'job.started',
      jobId,
      request: '海辺',
      stopConditions: { aiJudgement: false, maxIterations: 1 },
    });
  const all = async () => (await store.readEvents(conversationId, { limit: 100_000 })).events;
  return { store, conversationId, add, round, job, all, turn: () => turn, nextTurn: () => ++turn };
}

/** 直す前の読み方: 会話を頭から全部読んで決める */
function fromAllEvents(events: ConversationEvent[]) {
  const read = new Set(events.flatMap((e) => (e.type === 'turn.started' ? e.messageSeqs : [])));
  return {
    unread: events.filter((e) => e.type === 'user.message' && !read.has(e.seq)).map((e) => e.seq),
    nextTurn:
      Math.max(0, ...events.flatMap((e) => (e.type === 'turn.started' ? [e.turn] : []))) + 1,
    job: events.findLast((e) => e.type === 'job.started'),
  };
}

const inputOf = (
  events: readonly ConversationEvent[],
  unread: number[],
  limits: TalkLimits,
  earlierMessages = false,
) =>
  buildTalkInput({
    events,
    earlierMessages,
    messageSeqs: unread,
    steps: [],
    final: false,
    limits,
    window: DEFAULT_MODEL_WINDOW,
  });

/** 末尾から読んだ結果が、全部読んだ結果と同じかを見る。入力は、送る中身と見積もりと、落とした部分の印が同じ */
async function expectSameAsReadingAll(
  c: Awaited<ReturnType<typeof conversation>>,
  reader: TalkWindowReader,
  limits: TalkLimits = DEFAULT_TALK_LIMITS,
  /** 最初に読むときの直近の件数（実行器は、最後に分かっている設定で読み、設定を読んでから読み足す） */
  firstRead = limits.recentMessages,
) {
  const events = await c.all();
  const before = fromAllEvents(events);
  const window = await reader.widen(
    c.conversationId,
    await reader.read(c.conversationId, firstRead),
    limits.recentMessages,
  );
  expect(window.unread).toEqual(before.unread);
  expect(window.nextTurn).toBe(before.nextTurn);
  expect(window.events.findLast((e) => e.type === 'job.started')).toEqual(before.job);
  const expected = inputOf(events, before.unread, limits);
  const actual = inputOf(window.events, window.unread, limits, window.oldest !== undefined);
  expect(actual.system).toBe(expected.system);
  expect(actual.user).toEqual(expected.user);
  expect(actual.report.estimatedInputTokens).toBe(expected.report.estimatedInputTokens);
  const marks = (notes: typeof expected.report.notes) =>
    notes.map((n) => `${n.kind}:${n.section}`).sort();
  expect(marks(actual.report.notes)).toEqual(marks(expected.report.notes));
  return window;
}

describe('reading only the tail of a conversation for a talk turn', () => {
  for (const pageSize of [3, 100]) {
    it(`gives the same input as reading it all, for a long conversation with a job far back (page ${pageSize})`, async () => {
      const c = await conversation();
      await c.round('最初');
      await c.job('20261009-000000-job1');
      for (let i = 0; i < 300; i += 1) await c.round(`発言 ${i}`);
      await c.add({ type: 'user.message', text: '続けて', attachments: [] });

      await expectSameAsReadingAll(c, new TalkWindowReader(c.store, pageSize));
    });

    it(`counts a message that came in while a turn was starting as unread (page ${pageSize})`, async () => {
      const c = await conversation();
      for (let i = 0; i < 20; i += 1) await c.round(`発言 ${i}`);
      // ターンが発言を読んだあと、turn.started を書く前に、次の発言が届いた
      const first = await c.add({ type: 'user.message', text: '描いて', attachments: [] });
      const late = await c.add({ type: 'user.message', text: 'やっぱり猫も', attachments: [] });
      await c.add({ type: 'turn.started', turn: c.turn() + 1, messageSeqs: [first.seq] });
      await c.add({
        type: 'assistant.message',
        turn: c.turn() + 1,
        partId: 'cut',
        text: '描きま',
        interrupted: true,
      });
      await c.add({ type: 'turn.ended', turn: c.turn() + 1, outcome: 'interrupted' });

      const window = await expectSameAsReadingAll(c, new TalkWindowReader(c.store, pageSize));
      expect(window.unread).toEqual([late.seq]);
    });

    it(`reads every message when no turn has started yet (page ${pageSize})`, async () => {
      const c = await conversation();
      for (let i = 0; i < 30; i += 1) {
        await c.add({ type: 'user.message', text: `発言 ${i}`, attachments: [] });
      }

      const window = await expectSameAsReadingAll(c, new TalkWindowReader(c.store, pageSize));
      expect(window.unread).toHaveLength(30);
    });

    it(`finds no job when the conversation never drew (page ${pageSize})`, async () => {
      const c = await conversation();
      for (let i = 0; i < 50; i += 1) await c.round(`発言 ${i}`);
      await c.add({ type: 'user.message', text: '続けて', attachments: [] });

      await expectSameAsReadingAll(c, new TalkWindowReader(c.store, pageSize));
    });
  }

  it('reads about the same amount at each turn however long the conversation grows', async () => {
    const c = await conversation();
    await c.job('20261009-000000-job1');
    for (let i = 0; i < 1000; i += 1) await c.round(`発言 ${i}`);
    const reader = new TalkWindowReader(c.store);
    /** 発言してターンを1つ回したつもりで読み、読んだ数を返す */
    const turn = async () => {
      await c.add({ type: 'user.message', text: '続けて', attachments: [] });
      c.store.read = 0;
      const window = await expectSameAsReadingAll(c, reader);
      const read = c.store.read;
      // ターンが、未読の発言を読んで答えたつもり
      const t = c.nextTurn();
      expect(t).toBe(window.nextTurn);
      await c.add({ type: 'turn.started', turn: t, messageSeqs: window.unread });
      await c.add({ type: 'assistant.message', turn: t, partId: `t${t}`, text: 'はい' });
      await c.add({ type: 'turn.ended', turn: t, outcome: 'done' });
      return read;
    };
    // 最初の1回だけは、ジョブの job.started を探して頭まで読む
    expect(await turn()).toBeGreaterThan(4000);

    const atFirst = await turn();
    // 会話がさらに約 4000 件伸びても（その間もターンは回る）、1ターンに読む数は変わらない
    for (let i = 0; i < 1000; i += 1) await c.round(`さらに ${i}`);
    await turn();
    const later = await turn();
    expect(later).toBe(atFirst);
    // 直近 12 件の発言は 24 件ほどのイベントにあり、1ページ（100 件）で足りる
    expect(later).toBeLessThanOrEqual(100);
  });

  it('reads further back when the setting asks for more recent messages than it read', async () => {
    const c = await conversation();
    await c.job('20261009-000000-job1');
    for (let i = 0; i < 200; i += 1) await c.round(`発言 ${i}`);
    await c.job('20261009-010000-job2');
    await c.add({ type: 'user.message', text: '続けて', attachments: [] });
    const limits = { ...DEFAULT_TALK_LIMITS, recentMessages: 150 };

    await expectSameAsReadingAll(c, new TalkWindowReader(c.store, 10), limits, 12);
  });

  for (const pageSize of [1, 100]) {
    it(`stops at the recent messages it needs, and still marks that older ones were left out (page ${pageSize})`, async () => {
      const c = await conversation();
      for (let i = 0; i < 100; i += 1) await c.round(`発言 ${i}`);
      await c.job('20261009-000000-job1');
      await c.round('描いて');
      await c.add({ type: 'user.message', text: '続けて', attachments: [] });
      c.store.read = 0;

      await expectSameAsReadingAll(c, new TalkWindowReader(c.store, pageSize));
      expect(c.store.read).toBeLessThan(200);
      // 読み足さなくても、最初の読みで直近の件数はそろっている
      const first = await new TalkWindowReader(c.store, pageSize).read(c.conversationId, 12);
      expect(first.said).toBeGreaterThanOrEqual(12);
    });

    it(`reads back past a message that came in while the last turn was starting, even when it needs few recent messages (page ${pageSize})`, async () => {
      const c = await conversation();
      await c.job('20261009-000000-job1');
      for (let i = 0; i < 20; i += 1) await c.round(`発言 ${i}`);
      // 前のターンで1度読んで、ジョブの場所を覚えている読み手
      const remembering = new TalkWindowReader(c.store, pageSize);
      await remembering.read(c.conversationId, 1);
      const first = await c.add({ type: 'user.message', text: '描いて', attachments: [] });
      const late = await c.add({ type: 'user.message', text: 'やっぱり猫も', attachments: [] });
      await c.add({ type: 'turn.started', turn: c.nextTurn(), messageSeqs: [first.seq] });
      await c.add({ type: 'turn.ended', turn: c.turn(), outcome: 'interrupted' });
      // ページ（1・2・4 件と広がる）の境目が turn.started に来るように、後ろにもう1件置く
      await c.add({
        type: 'job.stopped',
        jobId: '20261009-000000-job1',
        reason: { kind: 'human', detail: '止めた' },
      });
      const limits = { ...DEFAULT_TALK_LIMITS, recentMessages: 1 };

      const window = await expectSameAsReadingAll(
        c,
        new TalkWindowReader(c.store, pageSize),
        limits,
      );
      expect(window.unread).toEqual([late.seq]);
      // 割り込みの確かめは、直近の発言を要らないとして読む。それでも、遅れて届いた発言を未読と分かる
      // 打ち切られたターンの間にも読んでいて、遅れて届いた発言より後まで覚えている
      await remembering.read(c.conversationId, 0);
      const check = await remembering.read(c.conversationId, 0);
      expect(check.unread).toEqual([late.seq]);
    });
  }

  it('notices a job started after the one it remembered', async () => {
    const c = await conversation();
    await c.job('20261009-000000-job1');
    for (let i = 0; i < 300; i += 1) await c.round(`発言 ${i}`);
    const reader = new TalkWindowReader(c.store, 50);
    await c.add({ type: 'user.message', text: '続けて', attachments: [] });
    await expectSameAsReadingAll(c, reader);

    await c.job('20261009-010000-job2');
    for (let i = 0; i < 200; i += 1) await c.round(`さらに ${i}`);
    await c.add({ type: 'user.message', text: '続けて', attachments: [] });
    const window = await expectSameAsReadingAll(c, reader);
    expect(window.events.findLast((e) => e.type === 'job.started')).toMatchObject({
      jobId: '20261009-010000-job2',
    });
  });

  // ページの境目が、覚えた位置のすぐ後ろのどこに来ても、新しいジョブを見落とさない
  for (let after = 0; after <= 12; after += 1) {
    it(`notices a job started right after where it last read, with ${after} events after the job (page 1)`, async () => {
      const c = await conversation();
      await c.job('20261009-000000-job1');
      for (let i = 0; i < 20; i += 1) await c.round(`発言 ${i}`);
      const reader = new TalkWindowReader(c.store, 1);
      await c.add({ type: 'user.message', text: '続けて', attachments: [] });
      const limits = { ...DEFAULT_TALK_LIMITS, recentMessages: 1 };
      const first = await expectSameAsReadingAll(c, reader, limits);
      // そのターンが、未読の発言を読んで描き始めたつもり。描き始める直前に、割り込みの確かめで末尾を読む
      const t = c.nextTurn();
      await c.add({ type: 'turn.started', turn: t, messageSeqs: first.unread });
      await reader.read(c.conversationId, 0);
      await c.job('20261009-010000-job2');
      await c.add({ type: 'turn.ended', turn: t, outcome: 'done' });
      await c.round('描いて');
      for (let i = 0; i < after; i += 1) {
        await c.add({ type: 'user.message', text: `追加 ${i}`, attachments: [] });
      }
      const window = await expectSameAsReadingAll(c, reader, limits);
      expect(window.events.findLast((e) => e.type === 'job.started')).toMatchObject({
        jobId: '20261009-010000-job2',
      });
    });
  }
});
