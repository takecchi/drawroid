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
  const started = (jobId: string, seq: number): ConversationEvent => ({
    type: 'job.started',
    jobId,
    request: '夕焼け',
    stopConditions: { aiJudgement: false },
    seq,
    at,
  });

  it('reads the state of the latest job of the conversation', async () => {
    const read: string[] = [];
    const jobs = {
      readState: async (jobId: string) => {
        read.push(jobId);
        return { status: 'queued' };
      },
    } as unknown as JobStore;
    const { run } = setup({ jobs });

    const outcome = await run(
      'drawing_status',
      {},
      { events: [started('job-old', 1), started('job-new', 2)] },
    );

    expect(read).toEqual(['job-new']);
    expect(outcome.result).toContain('job-new');
    expect(outcome.result).not.toContain('job-old');
  });

  it('names which image of which iteration is the best', async () => {
    const jobs = {
      readState: async () => ({
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
      }),
    } as unknown as JobStore;
    const { run } = setup({ jobs });

    const outcome = await run('drawing_status', {}, { events: [started('job-1', 1)] });

    expect(outcome.result).toContain('最良は 2 回目の 2枚目（1.00）');
    expect(outcome.result).toContain('止まった理由: 人間が画像を選んだ');
  });
});
