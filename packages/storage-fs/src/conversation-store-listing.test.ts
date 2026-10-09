// 会話のイベントを読む・書くたびに、イベントのディレクトリを一覧しないことと、一覧しなくても、別のプロセスや
// 再起動のあとに書かれたイベントを見落とさないことを見る試験。置き場所は本物のファイル
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NewConversationEvent } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { dataPaths, eventFileName } from './paths.js';

// イベントのディレクトリを一覧した回数を数える
const listed = { events: 0 };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (path: string, ...rest: unknown[]) => {
      if (String(path).endsWith('events')) listed.events += 1;
      return (actual.readdir as (...args: unknown[]) => Promise<string[]>)(path, ...rest);
    }) as typeof actual.readdir,
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-conversation-listing-'));
  listed.events = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const at = new Date('2026-10-09T06:30:12.000Z');
const said = (text: string): NewConversationEvent => ({ type: 'user.message', text });
const texts = (events: { type: string; text?: string }[]) => events.map((e) => e.text);

async function conversationWith(count: number) {
  const store = new FsConversationStore(root);
  const { conversationId } = await store.createConversation(at);
  for (let i = 1; i <= count; i += 1) await store.appendEvent(conversationId, said(`${i}`), at);
  return { store, conversationId };
}

describe('reading and writing the events of a conversation without listing them each time', () => {
  it('lists the events once, and then reads the tail, pages from the head and writes without listing', async () => {
    const { store, conversationId } = await conversationWith(30);
    listed.events = 0;

    for (let i = 0; i < 5; i += 1) {
      expect(texts(await store.readEventsBefore(conversationId, { limit: 3 }))).toEqual([
        `${28 + i}`,
        `${29 + i}`,
        `${30 + i}`,
      ]);
      await store.appendEvent(conversationId, said(`${31 + i}`), at);
    }
    const page = await store.readEvents(conversationId, { after: 30, limit: 3 });
    expect(texts(page.events)).toEqual(['31', '32', '33']);
    expect(page.more).toBe(true);

    expect(listed.events).toBe(0);
  });

  it('sees events another process wrote after it last looked, and numbers its own after them', async () => {
    const { store, conversationId } = await conversationWith(5);
    await store.readEventsBefore(conversationId, { limit: 1 });
    // 別のプロセス（別の置き場所のオブジェクト）が 40 件書いた
    const other = new FsConversationStore(root);
    for (let i = 6; i <= 45; i += 1) await other.appendEvent(conversationId, said(`${i}`), at);

    expect(texts(await store.readEventsBefore(conversationId, { limit: 2 }))).toEqual(['44', '45']);
    const mine = await store.appendEvent(conversationId, said('46'), at);
    expect(mine.seq).toBe(46);
    const all = await store.readEvents(conversationId, { limit: 100 });
    expect(all.events.map((e) => e.seq)).toEqual(Array.from({ length: 46 }, (_, i) => i + 1));
    expect(all.more).toBe(false);
  });

  it('reads what was written before a restart, then writes after it', async () => {
    const { conversationId } = await conversationWith(12);
    const restarted = new FsConversationStore(root);

    expect(texts(await restarted.readEventsBefore(conversationId, { limit: 2 }))).toEqual([
      '11',
      '12',
    ]);
    expect((await restarted.appendEvent(conversationId, said('13'), at)).seq).toBe(13);
  });

  it('reads pages further back without looking past them', async () => {
    const { store, conversationId } = await conversationWith(20);

    expect(texts(await store.readEventsBefore(conversationId, { before: 6, limit: 3 }))).toEqual([
      '3',
      '4',
      '5',
    ]);
    expect(texts(await store.readEventsBefore(conversationId, { before: 3, limit: 5 }))).toEqual([
      '1',
      '2',
    ]);
    expect(await store.readEventsBefore(conversationId, { before: 1, limit: 5 })).toEqual([]);
  });

  it('falls back to listing for a conversation whose numbers have a gap, and keeps writing after the last', async () => {
    const { conversationId } = await conversationWith(10);
    const events = dataPaths(root).conversationFiles(conversationId).events;
    // 欠けを作る（このコードは作らないが、手で触られたデータでも読み違えないように）
    await rename(join(events, eventFileName(4)), join(root, 'moved.json'));
    const store = new FsConversationStore(root);

    expect(texts(await store.readEventsBefore(conversationId, { limit: 8 }))).toEqual([
      '2',
      '3',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
    expect((await store.appendEvent(conversationId, said('11'), at)).seq).toBe(11);
    expect((await store.readEvents(conversationId, { limit: 100 })).events).toHaveLength(10);
  });

  it('lists again when the events it remembered are gone', async () => {
    const { store, conversationId } = await conversationWith(10);
    await store.readEventsBefore(conversationId, { limit: 1 });
    const events = dataPaths(root).conversationFiles(conversationId).events;
    for (const name of await readdir(events)) await rm(join(events, name));
    listed.events = 0;

    expect(await store.readEventsBefore(conversationId, { limit: 3 })).toEqual([]);
    expect(listed.events).toBe(1);
    expect((await store.appendEvent(conversationId, said('1'), at)).seq).toBe(1);
  });
});
