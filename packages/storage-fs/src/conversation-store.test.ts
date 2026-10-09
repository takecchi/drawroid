import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NewConversationEvent } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsConversationStore } from './conversation-store.js';
import { FsJobStore } from './job-store.js';
import { dataPaths, TEMP_FILE_PREFIX } from './paths.js';

// link を1回だけ失敗させられるようにする: 置く直前で落ちたときに、何も残らず番号も欠けないことを決定的に見るため
const failNextLink = { armed: false };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: (async (from: string, to: string) => {
      if (failNextLink.armed) {
        failNextLink.armed = false;
        throw Object.assign(new Error('書き込みの途中で落ちた'), { code: 'EIO' });
      }
      return actual.link(from, to);
    }) as typeof actual.link,
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-conversations-'));
  failNextLink.armed = false;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const at = new Date('2026-10-09T06:30:12.000Z');
const said = (text: string): NewConversationEvent => ({ type: 'user.message', text });

describe('FsConversationStore', () => {
  it('creates a conversation, adds events in order, and reads them after a seq', async () => {
    const store = new FsConversationStore(root);
    const conversation = await store.createConversation(at);
    expect(conversation).toMatchObject({ title: '', createdAt: at.toISOString() });
    expect(conversation.conversationId).toMatch(/^20261009-063012-[0-9a-z]+$/);

    const id = conversation.conversationId;
    await store.appendEvent(id, said('何ができますか？'), at);
    await store.appendEvent(id, { type: 'turn.started', turn: 1, messageSeqs: [1] }, at);
    await store.appendEvent(id, { type: 'turn.ended', turn: 1, outcome: 'done' }, at);

    const all = await store.readEvents(id);
    expect(all.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'user.message'],
      [2, 'turn.started'],
      [3, 'turn.ended'],
    ]);
    expect(all.events[0]).toMatchObject({ text: '何ができますか？', attachments: [] });
    expect(all).toMatchObject({ last: 3, more: false });

    const after = await store.readEvents(id, { after: 1 });
    expect(after.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('reads a page at a time and says where it stopped and whether more remain', async () => {
    const store = new FsConversationStore(root);
    const { conversationId: id } = await store.createConversation(at);
    for (const text of ['a', 'b', 'c', 'd', 'e']) await store.appendEvent(id, said(text), at);

    const first = await store.readEvents(id, { limit: 2 });
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ last: 2, more: true });

    const last = await store.readEvents(id, { after: 4, limit: 2 });
    expect(last.events.map((e) => e.seq)).toEqual([5]);
    expect(last).toMatchObject({ last: 5, more: false });

    expect(await store.readEvents(id, { after: 5 })).toEqual({ events: [], last: 5, more: false });
  });

  it('numbers events added at the same time without gaps or duplicates', async () => {
    const store = new FsConversationStore(root);
    const { conversationId: id } = await store.createConversation(at);

    await Promise.all(Array.from({ length: 8 }, (_, i) => store.appendEvent(id, said(`${i}`), at)));

    const { events } = await store.readEvents(id);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('leaves no broken file and no gap in the seq when a write fails part way', async () => {
    const store = new FsConversationStore(root);
    const { conversationId: id } = await store.createConversation(at);
    await store.appendEvent(id, said('1件目'), at);

    failNextLink.armed = true;
    await expect(store.appendEvent(id, said('落ちる'), at)).rejects.toThrow(
      '書き込みの途中で落ちた',
    );

    const eventsDir = dataPaths(root).conversationFiles(id).events;
    expect((await readdir(eventsDir)).filter((n) => !n.startsWith(TEMP_FILE_PREFIX))).toEqual([
      '000001.json',
    ]);
    expect((await readdir(eventsDir)).filter((n) => n.startsWith(TEMP_FILE_PREFIX))).toEqual([]);

    const next = await store.appendEvent(id, said('2件目'), at);
    expect(next.seq).toBe(2);
    const { events } = await store.readEvents(id);
    expect(events.map((e) => [e.seq, e.type === 'user.message' ? e.text : ''])).toEqual([
      [1, '1件目'],
      [2, '2件目'],
    ]);
    // 置いたファイルは人間が開いて読める JSON
    JSON.parse(await readFile(join(eventsDir, '000002.json'), 'utf8'));
  });

  it('refuses an event of the wrong shape without placing anything', async () => {
    const store = new FsConversationStore(root);
    const { conversationId: id } = await store.createConversation(at);

    await expect(
      store.appendEvent(id, { type: 'turn.ended', turn: 0, outcome: 'done' }, at),
    ).rejects.toThrow();
    expect((await store.readEvents(id)).events).toEqual([]);
  });

  it('lists only conversations whose directory holds conversation.json, with no index to keep', async () => {
    const store = new FsConversationStore(root);
    const kept = await store.createConversation(at);
    const removed = await store.createConversation(new Date('2026-10-09T07:00:00.000Z'));
    // 書きかけで落ちた会話（conversation.json の無いディレクトリ）は数えない
    await mkdir(join(dataPaths(root).conversations, '20261009-080000-dead'), { recursive: true });
    expect((await store.listConversationIds()).sort()).toEqual(
      [kept.conversationId, removed.conversationId].sort(),
    );

    await rm(dataPaths(root).conversation(removed.conversationId), { recursive: true });

    expect(await store.listConversationIds()).toEqual([kept.conversationId]);
  });

  it('keeps a title that a human fixed', async () => {
    const store = new FsConversationStore(root);
    const conversation = await store.createConversation(at);

    await store.writeConversation({ ...conversation, title: '海辺の少女' });

    expect(await store.readConversation(conversation.conversationId)).toMatchObject({
      title: '海辺の少女',
    });
  });

  it('refuses a conversation ID that would point outside the conversations directory', async () => {
    const store = new FsConversationStore(root);

    await expect(store.readEvents('../jobs')).rejects.toThrow();
    await expect(store.appendEvent('../jobs', said('x'), at)).rejects.toThrow();
  });
});

describe('job.json and conversations', () => {
  it('still reads a job.json written before jobs could belong to a conversation', async () => {
    const jobs = new FsJobStore(root);
    const jobId = '20261009-063012-old1';
    const dir = dataPaths(root).job(jobId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'job.json'),
      JSON.stringify({
        jobId,
        createdAt: at.toISOString(),
        kind: 'auto',
        request: '海辺の少女',
        stopConditions: { aiJudgement: true, maxIterations: 10 },
        batchSize: 1,
      }),
    );

    const spec = await jobs.readJob(jobId);
    expect(spec).toMatchObject({ kind: 'auto', request: '海辺の少女' });
    expect(spec).not.toHaveProperty('conversationId');
  });

  it('keeps the conversation and the turn that made a job', async () => {
    const jobs = new FsJobStore(root);
    const created = await jobs.createJob(
      {
        kind: 'auto',
        request: '海辺の少女',
        stopConditions: { aiJudgement: true, maxIterations: 10 },
        batchSize: 1,
        conversationId: '20261009-063012-k3f9',
        turn: 2,
      },
      { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
      at,
    );

    expect(await jobs.readJob(created.jobId)).toMatchObject({
      conversationId: '20261009-063012-k3f9',
      turn: 2,
    });
  });
});
