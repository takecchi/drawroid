import { describe, expect, it, vi } from 'vitest';

import type { JobStore } from '../../job/store.js';
import type { JobSpec, JobState } from '../../job/types.js';
import type { LlmCallRecord } from '../../llm/record.js';
import type { SelectionRecord, SelectionVerdict } from '../../selection/selection.js';
import { ScriptedLlm } from '../../testing/scripted-llm.js';
import type { MemoryItem } from '../item.js';
import type { MemoryStore } from '../store.js';
import type { DistillEntry, DistillLog } from './log.js';
import { ReselectionDistiller, type ReselectionDistillerDeps } from './reselection.js';

// core は storage-fs に依存できない（向きが逆）ので、この試験が触る口だけをメモリに置く
class FakeJobStore {
  readonly jobs = new Map<string, JobSpec>();
  readonly states = new Map<string, JobState>();
  readonly selections = new Map<string, SelectionRecord>();
  readonly llmCalls: LlmCallRecord[] = [];

  async readJob(jobId: string) {
    return this.jobs.get(jobId)!;
  }
  async readState(jobId: string) {
    return this.states.get(jobId)!;
  }
  async listSelections() {
    return [...this.selections.values()];
  }
  async readStage() {
    return undefined;
  }
  async writeLlmCall(record: LlmCallRecord) {
    this.llmCalls.push(record);
  }
}

class FakeMemoryStore implements MemoryStore {
  async list() {
    return { items: [] as MemoryItem[], invalid: [] };
  }
  async get() {
    return null;
  }
  async put() {}
  async remove() {
    return false;
  }
  async update() {
    return { before: null };
  }
}

class FakeLog implements DistillLog {
  readonly entries: DistillEntry[] = [];
  async append(_jobId: string, entry: DistillEntry) {
    this.entries.push(entry);
  }
  async read() {
    return this.entries;
  }
}

/** 進めた分だけ、期限の来た待ちを走らせる偽の時計 */
class FakeTimers {
  private time = 0;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, ms: number) => {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.time + ms, callback });
    return handle;
  };
  clearTimeout = (handle: unknown) => {
    this.pending.delete(handle as number);
  };
  advance(ms: number) {
    this.time += ms;
    for (const [handle, { at, callback }] of [...this.pending]) {
      if (at > this.time) continue;
      this.pending.delete(handle);
      callback();
    }
  }
}

const JOB = '20261009-100000-aaaa';
const STOPPED_AT = '2026-10-09T10:00:00Z';
const QUIET = 5000;

/** 偽の時計の期限が来て走り出した非同期の処理を、進められるところまで進める */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(
  options: {
    state?: JobState;
    spec?: Partial<Extract<JobSpec, { kind: 'auto' }>>;
    llm?: ScriptedLlm | undefined;
    /** 渡さなければ QUIET を渡す。default なら渡さず、本体の既定で動かす */
    quiet?: 'default';
  } = {},
) {
  const store = new FakeJobStore();
  store.jobs.set(JOB, {
    jobId: JOB,
    createdAt: '2026-10-09T09:00:00Z',
    kind: 'auto',
    request: '夕暮れの海辺の少女',
    stopConditions: { aiJudgement: true },
    batchSize: 2,
    ...options.spec,
  });
  store.states.set(
    JOB,
    options.state ?? {
      status: 'stopped',
      stoppedAt: STOPPED_AT,
      imagesGenerated: 4,
      reason: { kind: 'ai', detail: '意図どおり' },
      carry: { intent: '夕暮れの海辺の少女、アニメ調', completedIterations: 2 },
    },
  );
  const llm =
    'llm' in options ? options.llm : new ScriptedLlm({ distill: () => ({ operations: [] }) });
  const log = new FakeLog();
  const timers = new FakeTimers();
  const errors: unknown[] = [];
  let clock = Date.parse('2026-10-09T10:30:00Z');
  const deps: ReselectionDistillerDeps = {
    store: store as unknown as JobStore,
    memory: new FakeMemoryStore(),
    log,
    llm: () => llm,
    ...(options.quiet === 'default' ? {} : { quietMs: QUIET }),
    now: () => new Date(clock),
    newCallId: (now) => `call-${now.toISOString()}`,
    timers,
    onError: (error) => errors.push(error),
  };
  const distiller = new ReselectionDistiller(deps);
  return {
    store,
    llm,
    log,
    timers,
    errors,
    distiller,
    setClock: (iso: string) => {
      clock = Date.parse(iso);
    },
    select: (imageKey: string, verdict: SelectionVerdict | null, selectedAt: string) => {
      store.selections.set(imageKey, { imageKey, verdict, selectedAt });
    },
  };
}

describe('distilling in the background after a stopped job is reselected', () => {
  it('runs once after the quiet time and records the call under the job as a distill', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET - 1);
    await flush();
    expect(t.llm!.calls).toHaveLength(0);
    t.timers.advance(1);
    // 期限が来た時点で、もう走っている（idle は待ちを前倒しで走らせるので、idle より先に見る）
    await flush();
    expect(t.llm!.calls).toHaveLength(1);
    await t.distiller.idle();

    expect(t.llm!.calls).toHaveLength(1);
    expect(t.store.llmCalls).toHaveLength(1);
    expect(t.store.llmCalls[0]).toMatchObject({
      jobId: JOB,
      iteration: null,
      role: 'think',
      purpose: 'distill',
    });
    expect(t.log.entries.map((e) => [e.kind, e.shown.selections])).toEqual([
      ['reselection', ['2-0']],
    ]);
    expect(t.log.entries[0]!.callId).toBe(t.store.llmCalls[0]!.callId);
  });

  it('runs once for notifications that keep arriving within the quiet time', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(3000);
    await flush();
    t.distiller.notify(JOB);
    t.timers.advance(3000);
    await flush();
    t.distiller.notify(JOB);
    t.timers.advance(QUIET - 1);
    await flush();
    expect(t.llm!.calls).toHaveLength(0);
    t.timers.advance(1);
    // 期限が来た時点で、もう走っている（idle は待ちを前倒しで走らせるので、idle より先に見る）
    await flush();
    expect(t.llm!.calls).toHaveLength(1);
    await t.distiller.idle();

    expect(t.llm!.calls).toHaveLength(1);
  });

  it('runs once more, never overlapping, for notifications that arrive while it is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    let overlapped = false;
    const llm = new ScriptedLlm({
      distill: async () => {
        running += 1;
        overlapped ||= running > 1;
        await gate;
        running -= 1;
        return { operations: [] };
      },
    });
    const t = setup({ llm });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
    t.select('2-1', 'rejected', '2026-10-09T10:40:00Z');
    t.distiller.notify(JOB);
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    release();
    await t.distiller.idle();

    expect(llm.calls).toHaveLength(2);
    expect(overlapped).toBe(false);
    expect(t.log.entries.map((e) => e.shown.selections)).toEqual([['2-0'], ['2-1']]);
  });

  it('distills, in the next run, a reselection made while this run was reading the selections', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');
    // 選択を読み終えてから蒸留を始めるまでの間に、人間がもう1枚を選び直す（そのあと時計が進む）
    const list = t.store.listSelections.bind(t.store);
    let reads = 0;
    t.store.listSelections = async () => {
      const records = await list();
      reads += 1;
      if (reads === 1) {
        t.select('2-1', 'rejected', '2026-10-09T10:30:00.500Z');
        t.setClock('2026-10-09T10:30:01Z');
      }
      return records;
    };

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();
    // 選び直しの PUT が送る知らせ
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    // 1回目は 2-0 だけを見た。2-1 は、次の蒸留で1度だけ見る（取りこぼさない）
    expect(t.log.entries.map((e) => e.shown.selections)).toEqual([['2-0'], ['2-1']]);
  });

  it('does not show again a reselection made at the very time the last run read the selections', async () => {
    const t = setup();
    // 読んだ時刻（偽の時計の今）とちょうど同じ時刻の選択。1回目の蒸留が見る
    t.select('2-0', 'favorite', '2026-10-09T10:30:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    // 同じ選び直しを二重に覚えない
    expect(t.log.entries.map((e) => e.shown.selections)).toEqual([['2-0']]);
    expect(t.llm!.calls).toHaveLength(1);
  });

  it.each([
    ['running', { status: 'running', startedAt: STOPPED_AT, imagesGenerated: 0 }],
    ['queued', { status: 'queued' }],
  ])('does nothing for a job that is %s', async (_name, state) => {
    // 止まった時刻が残っていても、止まっていなければ走らせない（時刻だけで判じていないことの確かめ）
    const t = setup({ state: { ...state, stoppedAt: STOPPED_AT } as unknown as JobState });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(t.llm!.calls).toHaveLength(0);
    expect(t.log.entries).toEqual([]);
  });

  it('hands over only the selections that changed since the last distillation', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    t.setClock('2026-10-09T11:00:00Z');
    t.select('3-0', 'rejected', '2026-10-09T10:45:00Z');
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(t.log.entries.map((e) => e.shown.selections)).toEqual([['2-0'], ['3-0']]);
  });

  it('does not call the LLM when nothing changed after the job stopped', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T09:50:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(t.llm!.calls).toHaveLength(0);
    expect(t.store.llmCalls).toEqual([]);
  });

  it('does nothing while no LLM is configured', async () => {
    const t = setup({ llm: undefined });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(t.log.entries).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  it('uses the distill budget copied into job.json', async () => {
    const t = setup({ spec: { budgets: { distill: { selections: { maxCount: 1 } } } } });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');
    t.select('2-1', 'rejected', '2026-10-09T10:11:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(t.log.entries[0]!.shown.selections).toHaveLength(1);
  });

  it('reports a failure to onError and runs again on the next notification', async () => {
    const llm = new ScriptedLlm({
      distill: (_call, n) => {
        if (n === 0) throw new Error('LLM が落ちた');
        return { operations: [] };
      },
    });
    const t = setup({ llm });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();
    expect(t.errors).toHaveLength(1);
    expect(String(t.errors[0])).toContain('LLM が落ちた');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(llm.calls).toHaveLength(2);
    expect(t.log.entries).toHaveLength(1);
  });

  it('passes the same reselection again in the next run when the LLM failed to answer', async () => {
    // 1回目はスキーマに合わない答えを返し続ける（構造化出力の失敗。何も覚えずに失敗が記録に残る）
    const llm = new ScriptedLlm({
      distill: (_call, n) => (n === 0 ? { operations: 'broken' } : { operations: [] }),
    });
    const t = setup({ llm });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();
    t.setClock('2026-10-09T10:31:00Z');
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    // 失敗の記録は残し、その回に渡した選び直しは次の蒸留でもう一度渡る
    expect(t.log.entries.map((e) => [e.failure !== undefined, e.shown.selections])).toEqual([
      [true, ['2-0']],
      [false, ['2-0']],
    ]);
  });

  it('does not pass the reselection again after a run that succeeded', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();
    t.setClock('2026-10-09T10:31:00Z');
    t.distiller.notify(JOB);
    t.timers.advance(QUIET);
    await t.distiller.idle();

    expect(t.log.entries.map((e) => e.shown.selections)).toEqual([['2-0']]);
    expect(t.llm!.calls).toHaveLength(1);
  });

  it('runs a waiting notification when idle is awaited instead of dropping it', async () => {
    const t = setup();
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    await t.distiller.idle();

    expect(t.llm!.calls).toHaveLength(1);
  });
});

// 既定の待ちは 5 秒（#134 の約束）。試験が渡す値ではなく、本体の既定を時間そのもので見る
describe('the default quiet time', () => {
  it('runs 5 seconds after the last notice, not sooner', async () => {
    const t = setup({ quiet: 'default' });
    t.select('2-0', 'favorite', '2026-10-09T10:10:00Z');

    t.distiller.notify(JOB);
    t.timers.advance(4_999);
    await flush();
    expect(t.llm!.calls).toHaveLength(0);
    t.timers.advance(1);
    // 期限が来た時点で、もう走っている（idle は待ちを前倒しで走らせるので、idle より先に見る）
    await flush();
    expect(t.llm!.calls).toHaveLength(1);
    await t.distiller.idle();

    expect(t.llm!.calls).toHaveLength(1);
  });
});
