import { describe, expect, it } from 'vitest';

import type { ImageBackend } from '../../backend.js';
import type { JobStore } from '../../job/store.js';
import { basicPermissions } from '../../loop/iteration-permissions.js';
import type { MemoryItem } from '../../memory/item.js';
import type { MemoryStore } from '../../memory/store.js';
import type { Permissions } from '../../permissions/permission.js';
import { StubBackend } from '../../testing/stub-backend.js';
import type { ConversationEvent } from '../events.js';
import { DEFAULT_TALK_LIMITS, type TalkLimits } from './limits.js';
import { createReadOnlyTools, type TalkTool } from './tools.js';

const at = '2026-10-09T00:00:00.000Z';

/** 呼ばれたメソッド名を残すバックエンド。副作用の無いツールが、呼んでよいものだけを呼ぶことを見る */
function spyBackend(backend: ImageBackend): { backend: ImageBackend; called: string[] } {
  const called: string[] = [];
  const proxy = new Proxy(backend, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        called.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { backend: proxy, called };
}

const permissionsWith = (loras: unknown) =>
  ({ ...basicPermissions({ width: 1024, height: 1024 }), loras }) as Permissions;

function setup(
  options: {
    loras?: { name: string; label?: string }[];
    permissions?: Permissions;
    memory?: MemoryStore;
    jobs?: JobStore;
    now?: () => Date;
  } = {},
) {
  const { backend, called } = spyBackend(
    new StubBackend({
      candidates: {
        lora: options.loras ?? [{ name: 'miku_v2' }, { name: 'rin_v1' }],
      },
    }),
  );
  const permissions = options.permissions ?? permissionsWith({ mode: 'auto' });
  const tools = createReadOnlyTools({
    backend,
    permissions: async () => permissions,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    jobs: options.jobs ?? ({} as JobStore),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const tool = (name: string): TalkTool => {
    const found = tools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`ツール ${name} が無い`);
    return found;
  };
  const run = (
    name: string,
    input: unknown,
    context: { events?: ConversationEvent[]; limits?: Partial<TalkLimits> } = {},
  ) =>
    tool(name).run(input, {
      conversationId: 'c1',
      turn: 1,
      events: context.events ?? [],
      limits: { ...DEFAULT_TALK_LIMITS, ...context.limits },
      signal: new AbortController().signal,
    });
  return { run, called };
}

const memoryItem = (id: string, body: string, tags: string[] = []): MemoryItem => ({
  id,
  body,
  tags,
  scope: 'always',
  sources: [],
  createdAt: at,
  updatedAt: at,
});

/** 読むだけの記憶の置き場。書く・消す呼び出しが来たら、その場で失敗する */
function readOnlyMemory(items: MemoryItem[]): { store: MemoryStore; reads: number[] } {
  const reads = [0];
  const refuse = () => Promise.reject(new Error('副作用の無いツールが記憶を書いた'));
  const store = {
    list: async () => {
      reads[0] = (reads[0] ?? 0) + 1;
      return { items, invalid: [] };
    },
    get: async () => null,
    put: refuse,
    remove: refuse,
    update: refuse,
  } as unknown as MemoryStore;
  return { store, reads };
}

describe('search_candidates', () => {
  it('lists only the fixed value when the permission is fixed', async () => {
    const { run } = setup({ permissions: permissionsWith({ mode: 'fixed', value: 'rin_v1' }) });

    const outcome = await run('search_candidates', { kind: 'lora' });

    expect(outcome.result).toContain('rin_v1');
    expect(outcome.result).not.toContain('miku_v2');
  });

  it('lists only the LoRAs of the fixed value, written as the list of names and weights it really is', async () => {
    const { run } = setup({
      permissions: permissionsWith({ mode: 'fixed', value: [{ name: 'rin_v1', weight: 0.8 }] }),
    });

    const outcome = await run('search_candidates', { kind: 'lora' });

    expect(outcome.result).toContain('rin_v1');
    expect(outcome.result).not.toContain('miku_v2');
  });

  it('lists every LoRA of the fixed value when it fixes more than one', async () => {
    const { run } = setup({
      permissions: permissionsWith({
        mode: 'fixed',
        value: [
          { name: 'rin_v1', weight: 0.8 },
          { name: 'miku_v2', weight: 1 },
        ],
      }),
    });

    const outcome = await run('search_candidates', { kind: 'lora' });

    expect(outcome.result).toContain('rin_v1');
    expect(outcome.result).toContain('miku_v2');
  });

  it('matches by the name, ignoring width and case, and by the label', async () => {
    const { run } = setup({
      loras: [{ name: 'Miku_V2', label: '初音ミク' }, { name: 'rin_v1' }],
    });

    // 全角・大文字の語でも、半角・小文字の名前に当たる
    const byName = await run('search_candidates', { kind: 'lora', query: 'ＭＩＫＵ' });
    expect(byName.result).toContain('Miku_V2');
    expect(byName.result).not.toContain('rin_v1');

    const byLabel = await run('search_candidates', { kind: 'lora', query: 'ミク' });
    expect(byLabel.result).toContain('Miku_V2');
  });

  it('matches a katakana label by a hiragana or half-width katakana query', async () => {
    const { run } = setup({
      loras: [{ name: 'lora_a', label: 'ミク' }, { name: 'rin_v1' }],
    });

    for (const query of ['みく', 'ﾐｸ']) {
      const outcome = await run('search_candidates', { kind: 'lora', query });
      expect(outcome.result).toContain('lora_a');
      expect(outcome.result).not.toContain('rin_v1');
    }
  });

  it('does not match a label that differs only by a long vowel mark, a voiced mark or a small kana', async () => {
    const { run } = setup({
      loras: [
        { name: 'lora_a', label: 'ビール' },
        { name: 'lora_b', label: 'ハケ' },
        { name: 'lora_c', label: 'びよういん' },
      ],
    });

    const longVowel = await run('search_candidates', { kind: 'lora', query: 'ビル' });
    expect(longVowel.result).not.toContain('lora_a');

    const voiced = await run('search_candidates', { kind: 'lora', query: 'バケ' });
    expect(voiced.result).not.toContain('lora_b');

    const small = await run('search_candidates', { kind: 'lora', query: 'びょういん' });
    expect(small.result).not.toContain('lora_c');
  });

  it('returns no more candidates than the count in the budget, and says how many were left', async () => {
    const { run } = setup({
      loras: ['a', 'b', 'c', 'd'].map((x) => ({ name: `lora_${x}` })),
    });

    const outcome = await run(
      'search_candidates',
      { kind: 'lora' },
      { limits: { candidates: { maxCount: 2, maxSize: 1000 } } },
    );

    expect(outcome.result.split('\n').filter((l) => l.startsWith('lora_'))).toHaveLength(2);
    expect(outcome.result).toContain('ほかに 2 件');
  });

  it('returns no more candidates than the characters in the budget', async () => {
    const { run } = setup({
      loras: ['a', 'b', 'c', 'd'].map((x) => ({ name: `lora_${x}` })),
    });

    // 名前 1 つが 6 文字。12 文字までなら 2 つ入る
    const outcome = await run(
      'search_candidates',
      { kind: 'lora' },
      { limits: { candidates: { maxCount: 20, maxSize: 12 } } },
    );

    expect(outcome.result.split('\n').filter((l) => l.startsWith('lora_'))).toHaveLength(2);
    expect(outcome.result).toContain('ほかに 2 件');
  });
});

describe('recall_memory', () => {
  it('returns no more memory than the count in the budget', async () => {
    const { store } = readOnlyMemory([
      memoryItem('m1', '好み1'),
      memoryItem('m2', '好み2'),
      memoryItem('m3', '好み3'),
    ]);
    const { run } = setup({ memory: store });

    const outcome = await run(
      'recall_memory',
      { query: '好み' },
      { limits: { memory: { maxCount: 2, maxSize: 1000 } } },
    );

    expect(outcome.result.split('\n')).toHaveLength(2);
  });

  it('returns no more memory than the characters in the budget', async () => {
    const { store } = readOnlyMemory([
      memoryItem('m1', 'あいうえお'),
      memoryItem('m2', 'かきくけこ'),
      memoryItem('m3', 'さしすせそ'),
    ]);
    const { run } = setup({ memory: store });

    // 本文 1 件が 5 文字。7 文字までなら 1 件だけ入る
    const outcome = await run(
      'recall_memory',
      { query: '好み' },
      { limits: { memory: { maxCount: 8, maxSize: 7 } } },
    );

    expect(outcome.result.split('\n')).toHaveLength(1);
  });

  it('only reads: it writes no memory and touches no backend', async () => {
    const { store, reads } = readOnlyMemory([memoryItem('m1', '好み1')]);
    const { run, called } = setup({ memory: store });

    const outcome = await run('recall_memory', { query: '好み' });

    expect(outcome.ok).toBe(true);
    expect(reads[0]).toBe(1);
    expect(called).toEqual([]);
  });
});

describe('describe_backend', () => {
  it('only probes the backend, and starts nothing', async () => {
    const { run, called } = setup();

    const outcome = await run('describe_backend', {});

    expect(outcome.ok).toBe(true);
    expect(called).toEqual(['probe']);
  });
});

describe('drawing_status', () => {
  type Stored = {
    conversationId: string;
    kind?: string;
    state: Record<string, unknown>;
    /** job.json の止める条件 */
    stopConditions?: Record<string, unknown>;
    /** interventions/ の止める条件の変更（古い順） */
    stopChanges?: Record<string, unknown>[];
  };
  /** 置き場所にあるジョブ。ID の並び順は問わない（ツールが時刻順に引く） */
  const storeOf = (stored: Record<string, Stored>) => {
    const jobs = {
      listJobIds: async () => Object.keys(stored),
      readJob: async (jobId: string) => ({
        jobId,
        kind: stored[jobId]?.kind ?? 'auto',
        conversationId: stored[jobId]?.conversationId,
        stopConditions: stored[jobId]?.stopConditions ?? { aiJudgement: true },
      }),
      readState: async (jobId: string) => stored[jobId]?.state,
      listInterventions: async (jobId: string) =>
        (stored[jobId]?.stopChanges ?? []).map((stopConditions, i) => ({
          kind: 'stopConditions',
          interventionId: `i${i}`,
          receivedAt: at,
          stopConditions,
        })),
    } as unknown as JobStore;
    return { jobs };
  };
  const runningAt = (
    completedIterations: number,
    imagesGenerated: number,
  ): Record<string, unknown> => ({
    status: 'running',
    startedAt: at,
    imagesGenerated,
    carry: { intent: '夕焼け', completedIterations },
  });
  const minutesAfterStart = (minutes: number) => () => new Date(Date.parse(at) + minutes * 60_000);
  const queued = (conversationId = 'c1'): Stored => ({
    conversationId,
    state: { status: 'queued' },
  });
  const stopped = (conversationId = 'c1'): Stored => ({
    conversationId,
    state: { status: 'stopped', reason: { kind: 'human', detail: '人間が止めた' } },
  });

  it('reads the state of the latest job of the conversation', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': stopped(),
      '20261010-120000-cccccc': stopped(),
      '20261010-110000-bbbbbb': stopped(),
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('ジョブ 20261010-120000-cccccc');
    expect(outcome.result).not.toMatch(/aaaaaa|bbbbbb/);
  });

  // ジョブ ID は秒までの時刻と乱数なので、同じ秒に止めて描き直すと、新しいジョブが ID の順で前に来ることがある
  it('reads the job going on even when a stopped job of the conversation comes later in the ID order', async () => {
    const { jobs } = storeOf({
      '20261010-120000-ffffff': stopped(),
      '20261010-120000-000000': queued(),
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('ジョブ 20261010-120000-000000');
  });

  it('does not take a job going on in another conversation over a stopped one of this conversation', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': stopped(),
      '20261010-110000-bbbbbb': queued('c2'),
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('ジョブ 20261010-100000-aaaaaa');
  });

  it('says there is no job when the conversation has none', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': queued('c2'),
      '20261010-110000-bbbbbb': { ...queued(), kind: 'manual' },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.summary).toBe('ジョブは無い');
  });

  it('skips the jobs of other conversations', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': queued(),
      '20261010-110000-bbbbbb': queued('c2'),
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('ジョブ 20261010-100000-aaaaaa');
  });

  it('names which image of which iteration is the best', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': {
        conversationId: 'c1',
        state: {
          status: 'stopped',
          reason: { kind: 'adopted', detail: '人間が画像を選んだ' },
          carry: {
            intent: '夕焼け',
            completedIterations: 2,
            best: {
              iteration: 2,
              imageIndex: 1,
              score: 1,
              params: {},
              issues: [],
              nextChange: '',
            },
          },
        },
      },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('最良は 2 回目の 2枚目（1.00）');
    expect(outcome.result).toContain('止まった理由: 人間が画像を選んだ');
  });

  it('tells the status of the job in Japanese, in the result and in the summary', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': { conversationId: 'c1', state: runningAt(0, 0) },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('走っている');
    expect(outcome.summary).toContain('走っている');
    expect(outcome.result + outcome.summary).not.toMatch(/running|queued|stopped/);
  });

  it('tells a job waiting in the queue as waiting for its turn', async () => {
    const { jobs } = storeOf({ '20261010-100000-aaaaaa': queued() });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('順番を待っている');
    expect(outcome.summary).toContain('順番を待っている');
  });

  it('tells a stopped job as stopped, with the reason, in Japanese', async () => {
    const { jobs } = storeOf({ '20261010-100000-aaaaaa': stopped() });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('止まった');
    expect(outcome.result).toContain('人間が止めた');
    expect(outcome.summary).toContain('止まった');
    expect(outcome.result + outcome.summary).not.toMatch(/stopped/);
  });

  it('tells how much is left of every stop condition of a job going on', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': {
        conversationId: 'c1',
        state: runningAt(2, 4),
        stopConditions: {
          aiJudgement: true,
          maxIterations: 6,
          maxImages: 8,
          maxDurationMs: 600_000,
        },
      },
    });
    const { run } = setup({ jobs, now: minutesAfterStart(3) });

    const outcome = await run('drawing_status', {});

    // 3 回目を回すところ（残り 4 回）・あと 4 枚・あと 7 分
    expect(outcome.result).toContain('残り 4 回・4 枚・約 7 分');
  });

  it('counts the remainder with the stop conditions changed while the job runs', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': {
        conversationId: 'c1',
        state: runningAt(2, 0),
        stopConditions: { aiJudgement: true, maxIterations: 6 },
        stopChanges: [{ maxIterations: 4 }],
      },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('残り 2 回');
    expect(outcome.result).not.toContain('残り 4 回');
  });

  it('tells the remainder of a job waiting in the queue too', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': {
        conversationId: 'c1',
        state: { status: 'queued' },
        stopConditions: { aiJudgement: true, maxIterations: 5 },
      },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('残り 5 回');
  });

  it('says no remainder for a job that has no limit to stop at', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': { conversationId: 'c1', state: runningAt(1, 1) },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).not.toContain('残り');
  });

  it('tells no remainder of a stopped job, only why it stopped', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': {
        ...stopped(),
        stopConditions: { aiJudgement: true, maxIterations: 6 },
      },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).not.toContain('残り');
    expect(outcome.result).toContain('人間が止めた');
  });

  it('tells the remainder of the job of this conversation, not of another conversation', async () => {
    const { jobs } = storeOf({
      '20261010-100000-aaaaaa': {
        conversationId: 'c1',
        state: runningAt(0, 0),
        stopConditions: { aiJudgement: true, maxIterations: 3 },
      },
      '20261010-110000-bbbbbb': {
        conversationId: 'c2',
        state: runningAt(0, 0),
        stopConditions: { aiJudgement: true, maxIterations: 9 },
      },
    });
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {});

    expect(outcome.result).toContain('残り 3 回');
    expect(outcome.result).not.toContain('残り 9 回');
  });
});
