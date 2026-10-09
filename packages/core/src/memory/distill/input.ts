import { packWithinBudget } from '../../budget/pack.js';
import type { BudgetedMessages } from '../../llm/port.js';
import type { ModelWindow } from '../../loop/budget.js';
import { seal, type Section, SectionWriter } from '../../loop/inputs.js';
import type { MemoryItem } from '../item.js';
import { describeMemoryDrop, type MemoryRoleLimits, selectMemory } from '../select.js';
import type { DistillBudget } from './budget.js';

export type SelectionVerdict = 'favorite' | 'rejected';

/** 人間の選択1件と、その画像の評価の短い欄。画像そのものは渡さない */
export type SelectionMaterial = {
  imageKey: string;
  /** null は選択を外したこと（選び直しのときだけ） */
  verdict: SelectionVerdict | null;
  /** 選び直しのときの、変わる前の選択 */
  previous?: SelectionVerdict | null;
  score?: number;
  issues: string[];
};

/** 口出しの原文1件。古い順に並べて渡す */
export type InterventionMaterial = { id: string; text: string };

/** ジョブが止まったときの蒸留の材料。ジョブのファイルからの詰め替えは呼び出し側が行う */
export type StoppedJobMaterial = {
  jobId: string;
  intent: string;
  stopReason: { kind: string; detail: string };
  interventions: readonly InterventionMaterial[];
  selections: readonly SelectionMaterial[];
  /** ジョブを作った会話での、そのジョブに関わる人間の発言（古い順）。会話に属さないジョブには無い */
  conversation?: readonly InterventionMaterial[];
};

/** 止まった後に選択が変わったときの、小さな蒸留の材料 */
export type ReselectionMaterial = {
  jobId: string;
  intent: string;
  changes: readonly SelectionMaterial[];
};

export type DistillInput = {
  messages: BudgetedMessages;
  /** 入力の上限まで通って、実際に LLM に見せたもの */
  shown: { interventions: string[]; selections: string[]; memory: MemoryItem[] };
};

const DISTILL_SYSTEM = [
  'あなたは、画像生成のジョブから人間の好みを学び、記憶の項目として残す役である。',
  '口出し・お気に入り・却下から、次の依頼でも効く好みだけを、短い項目として足すか、既存の項目を直す。',
  '既存の項目と同じ好みは足さずに直す。学ぶことが無ければ operations を空にする。',
].join('\n');

const VERDICT_LABEL: Record<SelectionVerdict, string> = {
  favorite: 'お気に入り',
  rejected: '却下',
};

function selectionSection(
  w: SectionWriter,
  selection: SelectionMaterial,
  budget: DistillBudget,
): Section {
  const name = `selection[${selection.imageKey}]`;
  const label = selection.verdict === null ? '選択を外した' : VERDICT_LABEL[selection.verdict];
  const previous =
    selection.previous === undefined
      ? ''
      : `（前は${selection.previous === null ? '選択なし' : VERDICT_LABEL[selection.previous]}）`;
  const score = selection.score === undefined ? '' : `・評価 ${selection.score.toFixed(2)}`;
  const issues = selection.issues.slice(0, budget.issuesPerSelection);
  if (selection.issues.length > issues.length) {
    w.notes.push({
      kind: 'clipped',
      section: `${name}.issues`,
      from: selection.issues.length,
      to: issues.length,
    });
  }
  const issueText =
    issues.length === 0
      ? ''
      : ` 問題点: ${issues.map((s, i) => w.clip(`${name}.issues[${i}]`, s, budget.issueChars)).join(' / ')}`;
  return { name, text: `${label}${previous}${score}${issueText}` };
}

function selectionSections(
  w: SectionWriter,
  selections: readonly SelectionMaterial[],
  budget: DistillBudget,
): Section[] {
  const packed = packWithinBudget(selections, { size: () => 1, limits: budget.selections });
  for (const { item } of packed.dropped) {
    w.notes.push({
      kind: 'dropped',
      section: `selection[${item.imageKey}]`,
      reason: '選択の件数の予算に入らない',
    });
  }
  return packed.included.map((s) => selectionSection(w, s, budget));
}

// 口出しの原文を渡す: 依頼の要点へ統合するときに文字数の上限で削られた好み（「指の崩れは許容しない」など）を拾うため（Issue #5 の B）
function interventionSections(
  w: SectionWriter,
  interventions: readonly InterventionMaterial[],
  budget: DistillBudget,
): Section[] {
  const clipped = interventions.map((intervention, index) => ({
    id: intervention.id,
    index,
    text: w.clip(`intervention[${intervention.id}]`, intervention.text, budget.interventionChars),
  }));
  const packed = packWithinBudget(clipped, {
    size: (i) => [...i.text].length,
    // 新しい口出しを先に入れる: 後の口出しほど、人間の最後の意図に近いため
    compare: (a, b) => b.index - a.index,
    limits: budget.interventions,
  });
  for (const { item, reason } of packed.dropped) {
    w.notes.push({
      kind: 'dropped',
      section: `intervention[${item.id}]`,
      reason:
        reason === 'count' ? '口出しの件数の予算に入らない' : '口出しの文字数の予算に入らない',
    });
  }
  const kept = new Set(packed.included);
  return clipped
    .filter((i) => kept.has(i))
    .map((i) => ({ name: `intervention[${i.id}]`, text: `口出し: ${i.text}` }));
}

// 会話での発言は、口出しと同じく新しいものから予算に入れる: 会話は長くなりうるので、件数と文字数で締める
function conversationSections(
  w: SectionWriter,
  messages: readonly InterventionMaterial[],
  budget: DistillBudget,
): Section[] {
  const clipped = messages.map((message, index) => ({
    id: message.id,
    index,
    text: w.clip(`message[${message.id}]`, message.text, budget.messageChars),
  }));
  const packed = packWithinBudget(clipped, {
    size: (m) => [...m.text].length,
    compare: (a, b) => b.index - a.index,
    limits: budget.messages,
  });
  for (const { item, reason } of packed.dropped) {
    w.notes.push({
      kind: 'dropped',
      section: `message[${item.id}]`,
      reason:
        reason === 'count'
          ? '会話での発言の件数の予算に入らない'
          : '会話での発言の文字数の予算に入らない',
    });
  }
  const kept = new Set(packed.included);
  return clipped
    .filter((m) => kept.has(m))
    .map((m) => ({ name: `message[${m.id}]`, text: `会話での人間の発言: ${m.text}` }));
}

function memorySection(item: MemoryItem): Section {
  const tags = item.tags.length === 0 ? '' : `・${item.tags.join(', ')}`;
  return {
    name: `memory[${item.id}]`,
    text: `既存の項目 ${item.id}（${item.scope}${tags}）: ${item.body}`,
  };
}

function recordMemoryDrops(
  w: SectionWriter,
  dropped: ReturnType<typeof selectMemory>['droppedByBudget'],
  limits: MemoryRoleLimits,
): void {
  for (const d of dropped) {
    w.notes.push({
      kind: 'dropped',
      section: `memory[${d.item.id}]`,
      reason: describeMemoryDrop(d, limits),
    });
  }
}

function intentSection(w: SectionWriter, intent: string, budget: DistillBudget): Section {
  return { name: 'intent', text: `依頼の要点:\n${w.clip('intent', intent, budget.intentChars)}` };
}

function finish(
  w: SectionWriter,
  required: Section[],
  optional: Section[],
  memory: MemoryItem[],
  window: ModelWindow,
): DistillInput {
  const messages = seal({
    system: DISTILL_SYSTEM,
    writer: w,
    required,
    optional,
    trailing: [],
    images: [],
    imageLongEdges: [],
    window,
  });
  const droppedByWindow = new Set(
    messages.report.notes.filter((n) => n.kind === 'dropped').map((n) => n.section),
  );
  const shownNames = optional.map((s) => s.name).filter((name) => !droppedByWindow.has(name));
  const idsOf = (prefix: string) =>
    shownNames.filter((n) => n.startsWith(`${prefix}[`)).map((n) => n.slice(prefix.length + 1, -1));
  const shownMemory = new Set(idsOf('memory'));
  return {
    messages,
    shown: {
      interventions: idsOf('intervention'),
      selections: idsOf('selection'),
      memory: memory.filter((item) => shownMemory.has(item.id)),
    },
  };
}

/**
 * ジョブが止まったときの蒸留の入力。口出しの原文・選択・既存の項目を、それぞれの予算で詰める。
 */
export function buildStoppedJobDistillInput(args: {
  material: StoppedJobMaterial;
  memory: readonly MemoryItem[];
  budget: DistillBudget;
  window: ModelWindow;
}): DistillInput {
  const { material, memory, budget, window } = args;
  const w = new SectionWriter();
  const required = [
    intentSection(w, material.intent, budget),
    {
      name: 'stopReason',
      text: `止まった理由: ${material.stopReason.kind} ${w.clip('stopReason', material.stopReason.detail, budget.stopDetailChars)}`,
    },
  ];
  const selected = selectMemory(memory, material.intent, budget.memory);
  recordMemoryDrops(w, selected.droppedByBudget, budget.memory);
  const optional = [
    ...interventionSections(w, material.interventions, budget),
    ...conversationSections(w, material.conversation ?? [], budget),
    ...selectionSections(w, material.selections, budget),
    // 既存の項目を最後に置く: 入力の上限で削るときは、学ぶ材料より先に削る
    ...selected.selected.map(memorySection),
  ];
  return finish(w, required, optional, selected.selected, window);
}

/**
 * 止まった後に選択が変わったときの、小さな蒸留の入力。変わった選択と、関係する既存の項目だけを載せる。
 */
// 口出しや変わっていない選択を載せ直さない: 1回目の蒸留で学び済みで、選び直すたびに同じ材料のトークンを払うことになるため（Issue #5 の A）
export function buildReselectionDistillInput(args: {
  material: ReselectionMaterial;
  memory: readonly MemoryItem[];
  budget: DistillBudget;
  window: ModelWindow;
}): DistillInput {
  const { material, memory, budget, window } = args;
  const w = new SectionWriter();
  const { always, ...shared } = budget.memory;

  // このジョブから学んだ項目を先に入れる: 選び直しで直す必要が出るのは、まずこれらだから
  const learned = packWithinBudget(
    memory.filter((item) => item.sources.includes(material.jobId)),
    {
      size: (item) => item.body.length,
      compare: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      limits: shared,
    },
  );
  recordMemoryDrops(w, learned.dropped, { ...shared });
  const remaining: MemoryRoleLimits = {
    ...(shared.maxCount === undefined
      ? {}
      : { maxCount: shared.maxCount - learned.included.length }),
    ...(shared.maxSize === undefined ? {} : { maxSize: shared.maxSize - learned.usedSize }),
    ...(always === undefined ? {} : { always }),
  };
  const learnedIds = new Set(learned.included.map((item) => item.id));
  const others = selectMemory(
    memory.filter((item) => !item.sources.includes(material.jobId)),
    material.intent,
    remaining,
  );
  recordMemoryDrops(w, others.droppedByBudget, remaining);
  const shownMemory = [
    ...learned.included,
    ...others.selected.filter((i) => !learnedIds.has(i.id)),
  ];

  const optional = [
    ...selectionSections(w, material.changes, budget),
    ...shownMemory.map(memorySection),
  ];
  return finish(w, [intentSection(w, material.intent, budget)], optional, shownMemory, window);
}
