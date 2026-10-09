// 会話に属するジョブの待ちが、会話へ job.held（確定しない）で流れることを、本物のファイルの置き場所の上で見る試験
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationHubs, relayJobHeld, type HubMessage, type JobStore } from '@drawroid/core';
import { MemoryConversationStore } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-relay-held-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const conversations = new MemoryConversationStore();
  const hubs = new ConversationHubs({ store: conversations });
  const store: JobStore = new FsJobStore(root);
  const { conversationId } = await conversations.createConversation(new Date());
  const relay = relayJobHeld({ store, hubs });
  const create = (withConversation: boolean) =>
    store.createJob(
      {
        kind: 'auto',
        request: '海',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
        ...(withConversation && { conversationId, turn: 1 }),
      },
      { status: 'queued', carry: { intent: '海', completedIterations: 0 } },
      new Date(),
    );
  const subscribe = async () => {
    const received: HubMessage[] = [];
    await hubs.get(conversationId).subscribe(0, (m) => void received.push(m));
    return received;
  };
  return { hubs, conversationId, relay, create, subscribe };
}

const helds = (received: HubMessage[]) =>
  received.flatMap((m) => (m.kind === 'live' && m.event.type === 'job.held' ? [m.event.held] : []));

describe('relayJobHeld', () => {
  it('streams held: true when the job starts waiting and held: false when it is released', async () => {
    const { relay, create, subscribe } = await setup();
    const job = await create(true);
    const received = await subscribe();

    relay(job.jobId, true);
    await vi.waitFor(() => expect(helds(received)).toEqual([true]));
    relay(job.jobId, false);
    await vi.waitFor(() => expect(helds(received)).toEqual([true, false]));
  });

  it('keeps the wait for a subscriber that joins while the job waits, and drops it once released', async () => {
    const { relay, create, subscribe } = await setup();
    const job = await create(true);

    relay(job.jobId, true);
    await vi.waitFor(async () => expect(helds(await subscribe())).toEqual([true]));

    relay(job.jobId, false);
    await vi.waitFor(async () => expect(helds(await subscribe())).toEqual([]));
  });

  it('streams nothing for a job that does not belong to a conversation', async () => {
    const { relay, create, subscribe } = await setup();
    const free = await create(false);
    const mine = await create(true);
    const received = await subscribe();

    relay(free.jobId, true);
    relay(free.jobId, false);
    relay(mine.jobId, true);
    await vi.waitFor(() => expect(helds(received)).toEqual([true]));
  });
});
