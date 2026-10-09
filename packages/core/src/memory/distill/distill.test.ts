import { describe, expect, it } from 'vitest';

import type {
  BudgetedMessages,
  LlmCall,
  LlmCallOutcome,
  LlmPort,
  LlmRole,
  LlmRoleInfo,
} from '../../llm/port.js';
import { DEFAULT_MODEL_WINDOW } from '../../loop/budget.js';
import type { MemoryItem } from '../item.js';
import type { MemoryStore } from '../store.js';
import { DEFAULT_DISTILL_BUDGET } from './budget.js';
import type { SelectionMaterial, StoppedJobMaterial } from './input.js';
import type { DistillEntry, DistillLog } from './log.js';
import { distillReselection, distillStoppedJob, type DistillDeps } from './run.js';
import { buildDistillOutputSchema } from './schema.js';

// M2 の ScriptedLlm（#19）はこの枝に無いので、LlmPort を満たす最小のスタブで代える
class StubLlm implements LlmPort {
  readonly calls: LlmCall<unknown>[] = [];

  constructor(private readonly reply: (call: LlmCall<unknown>) => unknown | Promise<unknown>) {}

  describe(role: LlmRole): LlmRoleInfo {
    return {
      provider: 'stub',
      model: `stub-${role}`,
      window: DEFAULT_MODEL_WINDOW,
      imageInput: true,
    };
  }

  async generateStructured<T>(call: LlmCall<T>): Promise<LlmCallOutcome<T>> {
    this.calls.push(call as LlmCall<unknown>);
    const raw = await this.reply(call as LlmCall<unknown>);
    const attempt = {
      rawOutput: JSON.stringify(raw),
      usage: { inputTokens: null, outputTokens: null },
      durationMs: 0,
    };
    const parsed = call.schema.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data, attempts: [attempt] }
      : {
          ok: false,
          reason: 'スキーマ検証に失敗した',
          attempts: [{ ...attempt, validationError: parsed.error.message }],
        };
  }
}

class InMemoryStore implements MemoryStore {
  readonly items = new Map<string, MemoryItem>();

  constructor(items: readonly MemoryItem[] = []) {
    for (const item of items) this.items.set(item.id, item);
  }

  async list() {
    return { items: [...this.items.values()], invalid: [] };
  }

  async get(id: string) {
    return this.items.get(id) ?? null;
  }

  async put(item: MemoryItem) {
    this.items.set(item.id, item);
  }

  async remove(id: string) {
    return this.items.delete(id);
  }
}

class InMemoryLog implements DistillLog {
  readonly entries = new Map<string, DistillEntry[]>();

  async append(jobId: string, entry: DistillEntry) {
    this.entries.set(jobId, [...(this.entries.get(jobId) ?? []), entry]);
  }

  async read(jobId: string) {
    return this.entries.get(jobId) ?? [];
  }
}

const JOB = '20261009-153012-k3f9';
const budget = DEFAULT_DISTILL_BUDGET;

function memoryItem(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    body: `好みの項目 ${id}`,
    tags: [],
    scope: 'tagged',
    sources: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function material(overrides: Partial<StoppedJobMaterial> = {}): StoppedJobMaterial {
  return {
    jobId: JOB,
    intent: '夕暮れの海辺に立つ少女、アニメ調',
    stopReason: { kind: 'ai', detail: '意図どおりと判断した' },
    interventions: [],
    selections: [],
    ...overrides,
  };
}

function setup(reply: (call: LlmCall<unknown>) => unknown, items: readonly MemoryItem[] = []) {
  const llm = new StubLlm(reply);
  const store = new InMemoryStore(items);
  const log = new InMemoryLog();
  let n = 0;
  const deps: DistillDeps = {
    llm,
    memory: store,
    log,
    window: DEFAULT_MODEL_WINDOW,
    now: () => new Date('2026-10-09T16:00:00Z'),
    newMemoryId: () => `new-${(n += 1)}`,
    callId: 'call-1',
  };
  return { llm, store, log, deps };
}

const textOf = (messages: BudgetedMessages) =>
  messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('');

const nothingLearned = () => ({ operations: [] });

const fingers = {
  op: 'add',
  body: '指の崩れは許容しない',
  tags: ['手'],
  scope: 'always',
} as const;

describe('distilling a stopped job', () => {
  it('learns a preference from an intervention whose words did not survive into the request gist', async () => {
    const { llm, store, log, deps } = setup(() => ({ operations: [fingers] }));

    await distillStoppedJob(
      deps,
      material({ interventions: [{ id: 'i1', text: '指の崩れは許容しない' }] }),
    );

    const call = llm.calls[0]!;
    expect(call.role).toBe('think');
    expect(call.purpose).toBe('distill');
    expect(textOf(call.messages)).toContain('指の崩れは許容しない');
    expect(await store.get('new-1')).toMatchObject({
      body: '指の崩れは許容しない',
      scope: 'always',
      sources: [JOB],
    });
    const [entry] = await log.read(JOB);
    expect(entry).toMatchObject({
      kind: 'stopped',
      callId: 'call-1',
      shown: { interventions: ['i1'] },
      applied: [{ op: 'add', id: 'new-1' }],
    });
  });

  it('passes the selections as their short evaluations, not as images', async () => {
    const { llm, deps } = setup(nothingLearned);
    const selections: SelectionMaterial[] = [
      { imageKey: '3-1', verdict: 'favorite', score: 0.82, issues: [] },
      { imageKey: '2-0', verdict: 'rejected', score: 0.4, issues: ['指が6本ある'] },
    ];

    await distillStoppedJob(deps, material({ selections }));

    const messages = llm.calls[0]!.messages;
    expect(messages.user.every((part) => part.type === 'text')).toBe(true);
    expect(textOf(messages)).toContain('お気に入り');
    expect(textOf(messages)).toContain('却下・評価 0.40 問題点: 指が6本ある');
  });

  it('keeps the input within budget however many preferences, interventions and selections there are', async () => {
    const items = Array.from({ length: 500 }, (_, n) =>
      memoryItem(`m${String(n).padStart(3, '0')}`, {
        scope: n % 2 === 0 ? 'always' : 'tagged',
        tags: ['アニメ'],
      }),
    );
    const { llm, log, deps } = setup(nothingLearned, items);

    await distillStoppedJob(
      deps,
      material({
        interventions: Array.from({ length: 300 }, (_, n) => ({
          id: `i${n}`,
          text: `口出し ${n} `.repeat(20),
        })),
        selections: Array.from({ length: 200 }, (_, n) => ({
          imageKey: `1-${n}`,
          verdict: 'rejected' as const,
          issues: ['あ'.repeat(500), 'い', 'う', 'え'],
        })),
      }),
    );

    const { report } = llm.calls[0]!.messages;
    expect(report.estimatedInputTokens).toBeLessThanOrEqual(report.inputTokenLimit);
    const [entry] = await log.read(JOB);
    const shownMemory = entry!.shown.memory.map((id) => items.find((i) => i.id === id)!);
    const always = shownMemory.filter((i) => i.scope === 'always');
    const tagged = shownMemory.filter((i) => i.scope === 'tagged');
    expect(always.length).toBeLessThanOrEqual(budget.memory.always!.maxCount!);
    expect(always.reduce((s, i) => s + i.body.length, 0)).toBeLessThanOrEqual(
      budget.memory.always!.maxSize!,
    );
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.length).toBeLessThanOrEqual(budget.memory.maxCount!);
    expect(entry!.shown.interventions.length).toBeLessThanOrEqual(budget.interventions.maxCount!);
    expect(entry!.shown.selections.length).toBeLessThanOrEqual(budget.selections.maxCount!);
  });

  it('records in distill.json everything it left out or clipped because of the budget', async () => {
    const items = Array.from({ length: 300 }, (_, n) =>
      memoryItem(`m${String(n).padStart(3, '0')}`, { scope: 'always' }),
    );
    const { log, deps } = setup(nothingLearned, items);

    await distillStoppedJob(
      deps,
      material({
        interventions: Array.from({ length: 50 }, (_, n) => ({ id: `i${n}`, text: '短い' })),
        selections: Array.from({ length: 20 }, (_, n) => ({
          imageKey: `1-${n}`,
          verdict: 'favorite' as const,
          issues: [],
        })),
      }),
    );

    const [entry] = await log.read(JOB);
    const dropped = (prefix: string) =>
      entry!.budgetNotes.filter((n) => n.kind === 'dropped' && n.section.startsWith(prefix));
    expect(entry!.shown.memory.length + dropped('memory[').length).toBe(300);
    expect(entry!.shown.interventions.length + dropped('intervention[').length).toBe(50);
    expect(entry!.shown.selections.length + dropped('selection[').length).toBe(20);
    expect(dropped('memory[')[0]).toMatchObject({
      reason: '記憶の always 枠の件数の予算に入らない',
    });
  });

  it('prefers the latest interventions when not all of them fit', async () => {
    const { log, deps } = setup(nothingLearned);

    await distillStoppedJob(
      deps,
      material({
        interventions: Array.from({ length: 20 }, (_, n) => ({ id: `i${n}`, text: '口出し' })),
      }),
    );

    const [entry] = await log.read(JOB);
    expect(entry!.shown.interventions).toEqual([
      'i12',
      'i13',
      'i14',
      'i15',
      'i16',
      'i17',
      'i18',
      'i19',
    ]);
  });

  it('edits a preference it was shown and adds the job to its sources once', async () => {
    const anime = memoryItem('anime', { tags: ['アニメ'], sources: ['older-job'] });
    const edit = {
      op: 'edit',
      id: 'anime',
      body: 'アニメ調は線を細く、彩度は控えめ',
      tags: ['アニメ'],
      scope: 'tagged',
    };
    const { store, log, deps } = setup(() => ({ operations: [edit] }), [anime]);

    await distillStoppedJob(deps, material());

    expect(await store.get('anime')).toMatchObject({
      body: 'アニメ調は線を細く、彩度は控えめ',
      sources: ['older-job', JOB],
      createdAt: anime.createdAt,
      updatedAt: '2026-10-09T16:00:00.000Z',
    });
    const [entry] = await log.read(JOB);
    expect(entry!.applied).toEqual([
      {
        op: 'edit',
        id: 'anime',
        before: { body: anime.body, tags: ['アニメ'], scope: 'tagged' },
        after: { body: edit.body, tags: ['アニメ'], scope: 'tagged' },
      },
    ]);
  });

  it('never deletes a preference, whatever the distiller answers', async () => {
    const items = [memoryItem('a', { scope: 'always' }), memoryItem('b', { scope: 'always' })];
    const { store, log, deps } = setup(() => ({ operations: [{ op: 'delete', id: 'a' }] }), items);

    await distillStoppedJob(deps, material());

    expect([...store.items.keys()].sort()).toEqual(['a', 'b']);
    expect((await log.read(JOB))[0]!.failure).toBeDefined();
  });

  it('does not overwrite or bring back a preference the human edited or deleted while it was distilling', async () => {
    const items = [
      memoryItem('edited', { scope: 'always' }),
      memoryItem('deleted', { scope: 'always' }),
    ];
    const operation = (id: string) => ({
      op: 'edit',
      id,
      body: 'AI の案',
      tags: [],
      scope: 'always',
    });
    const { store, log, deps } = setup(async () => {
      await store.put({ ...items[0]!, body: '人間の直し', updatedAt: '2026-10-09T15:59:00Z' });
      await store.remove('deleted');
      return { operations: [operation('edited'), operation('deleted')] };
    }, items);

    await distillStoppedJob(deps, material());

    expect((await store.get('edited'))?.body).toBe('人間の直し');
    expect(await store.get('deleted')).toBeNull();
    const [entry] = await log.read(JOB);
    expect(entry!.applied).toEqual([]);
    expect(entry!.skipped.map((s) => s.reason)).toEqual([
      '蒸留のあいだに項目が直された',
      '蒸留のあいだに人間が消した',
    ]);
  });

  it('leaves the memory as it was and records why when the output does not validate', async () => {
    const { store, log, deps } = setup(() => ({
      operations: [{ op: 'add', body: '指の崩れは許容しない', tags: [] }],
    }));

    const { entry } = await distillStoppedJob(deps, material());

    expect(store.items.size).toBe(0);
    expect(entry.failure).toBe('スキーマ検証に失敗した');
    expect(await log.read(JOB)).toEqual([entry]);
  });

  it('records the failure without calling the LLM when even the required input does not fit', async () => {
    const { llm, log, deps } = setup(nothingLearned);

    await distillStoppedJob(
      { ...deps, window: { contextTokens: 300, maxOutputTokens: 200 } },
      material(),
    );

    expect(llm.calls).toHaveLength(0);
    expect((await log.read(JOB))[0]).toMatchObject({ callId: null, applied: [] });
    expect((await log.read(JOB))[0]!.failure).toContain('上限');
  });
});

describe('the distill output schema', () => {
  const schema = buildDistillOutputSchema(['shown'], budget);

  it('requires a scope on every preference', () => {
    expect(
      schema.safeParse({ operations: [{ op: 'add', body: '指の崩れは許容しない', tags: [] }] })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ operations: [fingers] }).success).toBe(true);
  });

  it('lets the distiller edit only the preferences it was shown', () => {
    const edit = (id: string) => ({ op: 'edit', id, body: '好み', tags: [], scope: 'tagged' });

    expect(schema.safeParse({ operations: [edit('shown')] }).success).toBe(true);
    expect(schema.safeParse({ operations: [edit('hidden')] }).success).toBe(false);
    expect(
      buildDistillOutputSchema([], budget).safeParse({ operations: [edit('shown')] }).success,
    ).toBe(false);
  });

  it('keeps the output short', () => {
    const tooLong = { ...fingers, body: 'あ'.repeat(budget.output.body + 1) };
    const tooMany = Array.from({ length: budget.output.operations + 1 }, () => fingers);

    expect(schema.safeParse({ operations: [tooLong] }).success).toBe(false);
    expect(schema.safeParse({ operations: tooMany }).success).toBe(false);
  });
});

describe('distilling again after the selections change', () => {
  it('appends a small distillation built from the changed selections and the related preferences only', async () => {
    const unrelatedTagged = memoryItem('photo', { tags: ['実写'], body: '実写は彩度を控えめ' });
    const { llm, store, log, deps } = setup(
      (call) =>
        call.purpose === 'distill' && llm.calls.length === 1
          ? { operations: [{ ...fingers, tags: [], scope: 'tagged', body: '線は細く' }] }
          : nothingLearned(),
      [unrelatedTagged],
    );
    await distillStoppedJob(
      deps,
      material({ interventions: [{ id: 'i1', text: '線をもっと細く' }] }),
    );

    const result = await distillReselection(deps, {
      jobId: JOB,
      intent: material().intent,
      changes: [
        {
          imageKey: '2-1',
          verdict: 'rejected',
          previous: 'favorite',
          score: 0.7,
          issues: ['線が太い'],
        },
      ],
    });

    const text = textOf(llm.calls[1]!.messages);
    expect(text).toContain('却下（前はお気に入り）');
    expect(text).toContain('線は細く');
    expect(text).not.toContain('線をもっと細く');
    expect(text).not.toContain('実写は彩度を控えめ');
    expect(result?.entry.shown).toEqual({
      interventions: [],
      selections: ['2-1'],
      memory: ['new-1'],
    });
    expect((await log.read(JOB)).map((e) => e.kind)).toEqual(['stopped', 'reselection']);
    expect(store.items.size).toBe(2);
  });

  it('does nothing when no selection changed', async () => {
    const { llm, log, deps } = setup(nothingLearned);

    const result = await distillReselection(deps, {
      jobId: JOB,
      intent: material().intent,
      changes: [],
    });

    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
    expect(await log.read(JOB)).toEqual([]);
  });
});
