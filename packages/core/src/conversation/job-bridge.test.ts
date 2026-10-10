// 橋渡し（bridgeJobEvents）が、会話に属するジョブの止まりを onStopped で知らせる条件を見る試験（#345）。
// ジョブの置き場所はメモリの偽物（橋渡しが使う口だけ）、会話の置き場所は MemoryConversationStore
import { describe, expect, it, vi } from 'vitest';

import type { GenerationRequest, GenerationResult } from '../backend.js';
import type { JobStore, NewJobSpec, StageName } from '../job/store.js';
import type { AdoptedRecord, JobSpec, JobState, StopReason } from '../job/types.js';
import { MemoryConversationStore } from '../testing/memory-conversation-store.js';
import type { ConversationEvent } from './events.js';
import { bridgeJobEvents, type StoppedJob } from './job-bridge.js';
import { ConversationHubs } from './hub.js';

const now = new Date('2026-10-10T00:00:00.000Z');
const reason: StopReason = { kind: 'ai', detail: '満足した' };
const stopped: JobState = { status: 'stopped', reason, carry: undefined } as unknown as JobState;
const queued: JobState = {
  status: 'queued',
  carry: { intent: 'x', completedIterations: 0 },
} as unknown as JobState;

/** ブリッジが読み書きする口だけを持つ、メモリのジョブの置き場所 */
class FakeJobStore {
  readonly specs = new Map<string, JobSpec>();
  readonly stages = new Map<string, unknown>();
  private next = 1;

  async createJob(spec: NewJobSpec, _state: JobState, at: Date): Promise<JobSpec> {
    const created = {
      ...spec,
      jobId: `job-${this.next++}`,
      createdAt: at.toISOString(),
    } as JobSpec;
    this.specs.set(created.jobId, created);
    return created;
  }
  async readJob(jobId: string): Promise<JobSpec> {
    const spec = this.specs.get(jobId);
    if (spec === undefined) throw new Error(`ジョブ ${jobId} は無い`);
    return spec;
  }
  async writeState(): Promise<void> {}
  async writeStage(jobId: string, iteration: number, stage: StageName, value: unknown) {
    this.stages.set(`${jobId}/${iteration}/${stage}`, value);
  }
  async readStage(jobId: string, iteration: number, stage: StageName) {
    return this.stages.get(`${jobId}/${iteration}/${stage}`);
  }
  async writeAdopted(): Promise<void> {}
  async writeGeneration(): Promise<void> {}
  async markInterventionApplied(): Promise<void> {}
  async listInterventions() {
    return [];
  }
}

const autoSpec = (conversationId?: string): NewJobSpec => ({
  kind: 'auto',
  request: '夕暮れの海辺',
  stopConditions: { aiJudgement: false, maxIterations: 2 },
  batchSize: 1,
  ...(conversationId !== undefined && { conversationId, turn: 1 }),
});

/** appendEvent が、指定の型のイベントだけ投げるストア */
class FailingStore extends MemoryConversationStore {
  failOn: string | undefined;
  override async appendEvent(
    ...args: Parameters<MemoryConversationStore['appendEvent']>
  ): Promise<ConversationEvent> {
    if (args[1].type === this.failOn) throw new Error('確定できない');
    return super.appendEvent(...args);
  }
}

async function setup() {
  const conversations = new FailingStore();
  const hubs = new ConversationHubs({ store: conversations, now: () => now });
  const inner = new FakeJobStore();
  const errors: unknown[] = [];
  const onStopped = vi.fn<(stop: StoppedJob) => void>();
  const bridge = (): JobStore =>
    bridgeJobEvents(inner as unknown as JobStore, {
      hubs,
      onError: (error) => errors.push(error),
      onStopped,
    });
  const { conversationId } = await conversations.createConversation(now);
  return { conversations, inner, errors, onStopped, bridge, conversationId };
}

const eventTypes = async (store: MemoryConversationStore, conversationId: string) =>
  (await store.readEvents(conversationId)).events.map((e) => e.type);

describe('bridgeJobEvents onStopped', () => {
  it('does not call onStopped for stages other than stopped', async () => {
    const { bridge, onStopped, conversationId, conversations } = await setup();
    const store = bridge();
    const job = await store.createJob(autoSpec(conversationId), queued, now);

    await store.writeStage(job.jobId, 1, 'think', { params: {}, rationale: '足す' });
    await store.writeGeneration(
      job.jobId,
      1,
      { width: 512, height: 512 } as GenerationRequest,
      { images: [{ seed: 1 }] } as unknown as GenerationResult,
    );
    await store.writeStage(job.jobId, 1, 'judge', {
      images: [{ score: 0.5, issues: [] }],
      nextChange: 'もう少し',
      canStop: false,
    });
    await store.writeAdopted(job.jobId, 1, {
      by: 'human',
      image: { iteration: 1, index: 0 },
    } as AdoptedRecord);

    expect(await eventTypes(conversations, conversationId)).toEqual([
      'job.started',
      'job.think',
      'job.images',
      'job.judge',
      'job.adopted',
    ]);
    expect(onStopped).not.toHaveBeenCalled();
  });

  it('calls onStopped exactly once after job.stopped is confirmed in the conversation', async () => {
    const { bridge, onStopped, conversationId, conversations } = await setup();
    const store = bridge();
    const job = await store.createJob(autoSpec(conversationId), queued, now);
    let typesAtCall: string[] = [];
    onStopped.mockImplementation(async () => {
      typesAtCall = await eventTypes(conversations, conversationId);
    });

    await store.writeState(job.jobId, stopped);
    // onStopped の中で読む前に確かめるため、読み終わるまで待つ
    await vi.waitFor(() => expect(typesAtCall).toEqual(['job.started', 'job.stopped']));

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith({ conversationId, jobId: job.jobId, reason });
  });

  it('does not call onStopped for a job that belongs to no conversation', async () => {
    const { bridge, onStopped, errors } = await setup();
    const store = bridge();
    const job = await store.createJob(autoSpec(), queued, now);

    await store.writeState(job.jobId, stopped);

    expect(onStopped).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('does not call onStopped, and reports to onError, when confirming job.stopped throws', async () => {
    const { bridge, onStopped, errors, conversationId, conversations } = await setup();
    const store = bridge();
    const job = await store.createJob(autoSpec(conversationId), queued, now);
    conversations.failOn = 'job.stopped';

    await store.writeState(job.jobId, stopped);

    expect(onStopped).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it('resolves writeState and reports to onError when onStopped throws', async () => {
    const { bridge, onStopped, errors, conversationId, conversations } = await setup();
    const store = bridge();
    const job = await store.createJob(autoSpec(conversationId), queued, now);
    const boom = new Error('話しかけられない');
    onStopped.mockImplementation(() => {
      throw boom;
    });

    await expect(store.writeState(job.jobId, stopped)).resolves.toBeUndefined();

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([boom]);
    expect(await eventTypes(conversations, conversationId)).toContain('job.stopped');
  });

  it('calls onStopped once for a job that was not created through the bridge', async () => {
    const { bridge, inner, onStopped, conversationId } = await setup();
    // 再起動で再開したジョブ: 置き場所に先にあり、この橋渡しは createJob を見ていない
    const existing = await inner.createJob(autoSpec(conversationId), queued, now);
    const store = bridge();

    await store.writeState(existing.jobId, stopped);

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith({ conversationId, jobId: existing.jobId, reason });
  });
});
