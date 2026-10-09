import { describe, expect, it } from 'vitest';

import { MemoryConversationStore } from '../testing/memory-conversation-store.js';
import type { ConversationEvent, LiveEvent } from './events.js';
import { ConversationHub, type HubMessage } from './hub.js';
import type { ConversationEventPage } from './store.js';

const now = () => new Date('2026-10-09T06:30:12.000Z');

/** ファイルを読む口を、試験が開けるまで待たせるストア。購読を張ってから読み終えるまでの間に、何かを起こすため */
class GatedStore extends MemoryConversationStore {
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  override async readEvents(
    conversationId: string,
    options?: { after?: number; limit?: number },
  ): Promise<ConversationEventPage> {
    await this.gate;
    return super.readEvents(conversationId, options);
  }
}

async function setup() {
  const store = new GatedStore();
  const { conversationId } = await store.createConversation(now());
  const hub = new ConversationHub({ store, conversationId, now });
  return { store, hub, conversationId };
}

const delta = (partId: string, text: string): LiveEvent => ({
  type: 'delta.text',
  partId,
  turn: 1,
  text,
});

function collector() {
  const received: HubMessage[] = [];
  return {
    received,
    send: (message: HubMessage) => void received.push(message),
    confirmedSeqs: () => received.flatMap((m) => (m.kind === 'confirmed' ? [m.event.seq] : [])),
    liveTexts: (partId: string) =>
      received.flatMap((m) =>
        m.kind === 'live' && m.event.type === 'delta.text' && m.event.partId === partId
          ? [m.event.text]
          : [],
      ),
  };
}

describe('subscribing while increments are flowing', () => {
  it('neither loses nor repeats any of the text, from the copy through to the confirmed message', async () => {
    const { store, hub } = await setup();
    await hub.confirm({ type: 'user.message', text: 'こんにちは' });
    hub.live(delta('p1', 'いらっ'));
    hub.live(delta('p1', 'しゃい'));

    const watcher = collector();
    store.hold();
    const subscribing = hub.subscribe(0, watcher.send);
    // 購読を張ってからファイルを読み終えるまでの間に、増分が届く
    hub.live(delta('p1', 'ませ。'));
    store.release();
    await subscribing;
    hub.live(delta('p1', '何を描きますか？'));
    const message = await hub.confirm({
      type: 'assistant.message',
      turn: 1,
      partId: 'p1',
      text: 'いらっしゃいませ。何を描きますか？',
    });

    expect(watcher.liveTexts('p1').join('')).toBe('いらっしゃいませ。何を描きますか？');
    expect(watcher.confirmedSeqs()).toEqual([1, message.seq]);
  });

  it('gives an event confirmed during the replay exactly once, and no stale copy of its part after it', async () => {
    const { store, hub } = await setup();
    await hub.confirm({ type: 'user.message', text: 'こんにちは' });
    hub.live(delta('p1', 'いらっしゃい'));

    const watcher = collector();
    store.hold();
    const subscribing = hub.subscribe(0, watcher.send);
    // ファイルを読んでいる間に、その部品の増分が届き、続けて確定する
    hub.live(delta('p1', 'ませ'));
    const confirmed = hub.confirm({
      type: 'assistant.message',
      turn: 1,
      partId: 'p1',
      text: 'いらっしゃいませ',
    });
    store.release();
    await Promise.all([subscribing, confirmed]);

    expect(watcher.confirmedSeqs()).toEqual([1, 2]);
    const confirmedAt = watcher.received.findIndex(
      (m) => m.kind === 'confirmed' && m.event.seq === 2,
    );
    expect(
      watcher.received
        .slice(confirmedAt + 1)
        .some((m) => m.kind === 'live' && m.event.type === 'delta.text'),
    ).toBe(false);
  });

  it('starts from after the seq it was given', async () => {
    const { hub } = await setup();
    for (const text of ['1', '2', '3']) await hub.confirm({ type: 'user.message', text });

    const watcher = collector();
    await hub.subscribe(2, watcher.send);

    expect(watcher.confirmedSeqs()).toEqual([3]);
  });
});

describe('the copy of what is flowing', () => {
  it('lets the copy go once the part is confirmed, and the confirmed event carries the same partId', async () => {
    const { hub } = await setup();
    hub.live(delta('p1', '考えています'));
    hub.live({
      type: 'delta.reasoning',
      partId: 'r1',
      source: { role: 'talk', turn: 1 },
      text: 'まず候補を',
    });

    const reasoning = await hub.confirm({
      type: 'assistant.reasoning',
      turn: 1,
      partId: 'r1',
      text: 'まず候補を',
    });
    const message = await hub.confirm({
      type: 'assistant.message',
      turn: 1,
      partId: 'p1',
      text: '考えています',
    });

    expect(reasoning).toMatchObject({ partId: 'r1' });
    expect(message).toMatchObject({ partId: 'p1' });
    const late = collector();
    await hub.subscribe(message.seq, late.send);
    expect(late.received).toEqual([]);
  });

  it('keeps only the latest progress of a job until its images are confirmed, and the latest status until the turn ends', async () => {
    const { hub } = await setup();
    const progress = (value: number): LiveEvent => ({
      type: 'generation.progress',
      jobId: 'job-1',
      iteration: 1,
      progress: value,
    });
    hub.live(progress(0.2));
    hub.live(progress(0.6));
    hub.live({ type: 'status', status: 'queued' });
    hub.live({ type: 'status', status: 'waiting-llm' });

    const before = collector();
    await hub.subscribe(0, before.send);
    expect(before.received.map((m) => m.event)).toEqual([
      progress(0.6),
      { type: 'status', status: 'waiting-llm' },
    ]);
    before.received.length = 0;

    const images = await hub.confirm({
      type: 'job.images',
      jobId: 'job-1',
      iteration: 1,
      images: [{ index: 0, seed: 7 }],
    });
    const ended = await hub.confirm({ type: 'turn.ended', turn: 1, outcome: 'done' });

    const after = collector();
    await hub.subscribe(ended.seq, after.send);
    expect(after.received).toEqual([]);
    expect(images.seq).toBeLessThan(ended.seq);
  });

  it('never writes the increments to the store', async () => {
    const { store, hub, conversationId } = await setup();
    for (let i = 0; i < 20; i++) hub.live(delta('p1', `${i}`));
    hub.live({ type: 'status', status: 'queued' });

    expect((await store.readEvents(conversationId)).events).toEqual([]);
  });
});

describe('subscribers that fail', () => {
  it('drops a subscriber whose send fails, without disturbing the others or the writer', async () => {
    const { hub } = await setup();
    const steady = collector();
    let failing = 0;
    const broken = await hub.subscribe(0, () => {
      failing++;
      throw new Error('接続が切れた');
    });
    await hub.subscribe(0, steady.send);

    const first = await hub.confirm({ type: 'user.message', text: '1' });
    hub.live(delta('p1', 'x'));
    const second = await hub.confirm({ type: 'user.message', text: '2' });

    expect(broken.closed).toBe(true);
    expect(failing).toBe(1);
    expect(steady.confirmedSeqs()).toEqual([first.seq, second.seq]);
    expect(steady.liveTexts('p1')).toEqual(['x']);
  });

  it('stops sending to a subscriber that closed', async () => {
    const { hub } = await setup();
    const watcher = collector();
    const subscription = await hub.subscribe(0, watcher.send);

    subscription.close();
    await hub.confirm({ type: 'user.message', text: '1' });

    expect(watcher.received).toEqual([]);
  });
});

describe('confirming', () => {
  it('gives subscribers the events in seq order even when they are confirmed at the same time', async () => {
    const { hub } = await setup();
    const watcher = collector();
    await hub.subscribe(0, watcher.send);

    const confirmed: ConversationEvent[] = await Promise.all(
      ['a', 'b', 'c', 'd'].map((text) => hub.confirm({ type: 'user.message', text })),
    );

    expect(watcher.confirmedSeqs()).toEqual([1, 2, 3, 4]);
    expect(confirmed.map((e) => e.seq).sort()).toEqual([1, 2, 3, 4]);
  });
});
