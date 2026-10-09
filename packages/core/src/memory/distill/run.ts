import type { BudgetedMessages, LlmCallOutcome, LlmPort } from '../../llm/port.js';
import type { ModelWindow } from '../../loop/budget.js';
import { InputOverBudgetError } from '../../loop/inputs.js';
import type { MemoryItem } from '../item.js';
import type { MemoryStore } from '../store.js';
import { applyDistillOperations } from './apply.js';
import { DEFAULT_DISTILL_BUDGET, type DistillBudget } from './budget.js';
import {
  buildReselectionDistillInput,
  buildStoppedJobDistillInput,
  type DistillInput,
  type ReselectionMaterial,
  type StoppedJobMaterial,
} from './input.js';
import type { DistillEntry, DistillLog } from './log.js';
import { buildDistillOutputSchema, type DistillOutput } from './schema.js';

export type DistillDeps = {
  llm: LlmPort;
  memory: MemoryStore;
  log: DistillLog;
  /** 考える役のモデルの窓（蒸留は考える役が行う） */
  window: ModelWindow;
  budget?: DistillBudget;
  now?: () => Date;
  newMemoryId?: () => string;
  /** LLM 呼び出しの記録の ID。distill.json から記録を辿るために残す */
  callId?: string;
  signal?: AbortSignal;
  /**
   * distill.json に残す時刻（at）。省けば蒸留を始めた時刻。選び直しの蒸留は、選択を読む直前の時刻を渡す
   * （次の選び直しの蒸留は、この時刻より後の選択だけを見るため）
   */
  startedAt?: Date;
};

export type DistillResult = {
  entry: DistillEntry;
  /** LLM 呼び出しの記録（toLlmCallRecord）を書くための入力と結果。呼ぶ前に止めたときは無い */
  call?: { messages: BudgetedMessages; outcome: LlmCallOutcome<DistillOutput> };
};

const defaultMemoryId = () => globalThis.crypto.randomUUID().slice(0, 8);

/** ジョブが止まったときに1回行う蒸留 */
export function distillStoppedJob(
  deps: DistillDeps,
  material: StoppedJobMaterial,
): Promise<DistillResult> {
  return distill(deps, material.jobId, 'stopped', (memory, budget) =>
    buildStoppedJobDistillInput({ material, memory, budget, window: deps.window }),
  );
}

/**
 * 止まった後に選択が変わったときの、小さな蒸留。変わった選択が無ければ何もしない。
 */
export async function distillReselection(
  deps: DistillDeps,
  material: ReselectionMaterial,
): Promise<DistillResult | null> {
  if (material.changes.length === 0) return null;
  return distill(deps, material.jobId, 'reselection', (memory, budget) =>
    buildReselectionDistillInput({ material, memory, budget, window: deps.window }),
  );
}

async function distill(
  deps: DistillDeps,
  jobId: string,
  kind: DistillEntry['kind'],
  buildInput: (memory: readonly MemoryItem[], budget: DistillBudget) => DistillInput,
): Promise<DistillResult> {
  const budget = deps.budget ?? DEFAULT_DISTILL_BUDGET;
  const now = deps.now ?? (() => new Date());
  const startedAt = deps.startedAt ?? now();
  const { items } = await deps.memory.list();

  let input: DistillInput;
  try {
    input = buildInput(items, budget);
  } catch (error) {
    if (!(error instanceof InputOverBudgetError)) throw error;
    const entry: DistillEntry = {
      kind,
      at: startedAt.toISOString(),
      callId: null,
      shown: { interventions: [], selections: [], memory: [] },
      budgetNotes: [],
      applied: [],
      skipped: [],
      failure: error.message,
    };
    await deps.log.append(jobId, entry);
    return { entry };
  }

  const { messages, shown } = input;
  const outcome = await deps.llm.generateStructured({
    role: 'think',
    purpose: 'distill',
    schema: buildDistillOutputSchema(
      shown.memory.map((item) => item.id),
      budget,
    ),
    messages,
    signal: deps.signal ?? new AbortController().signal,
  });
  const base = {
    kind,
    at: startedAt.toISOString(),
    callId: deps.callId ?? null,
    shown: { ...shown, memory: shown.memory.map((item) => item.id) },
    budgetNotes: messages.report.notes,
  };
  const entry: DistillEntry = outcome.ok
    ? {
        ...base,
        ...(await applyDistillOperations({
          store: deps.memory,
          operations: outcome.value.operations,
          shown: shown.memory,
          jobId,
          now: now(),
          newMemoryId: deps.newMemoryId ?? defaultMemoryId,
        })),
      }
    : { ...base, applied: [], skipped: [], failure: outcome.reason };
  await deps.log.append(jobId, entry);
  return { entry, call: { messages, outcome } };
}
