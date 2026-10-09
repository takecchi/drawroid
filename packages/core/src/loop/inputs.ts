import { clipText, estimateImageTokens, estimateTextTokens } from '../budget/estimate.js';
import { packWithinBudget } from '../budget/pack.js';
import type { MemoryItem } from '../memory/item.js';
import { describeMemoryDrop, type MemoryRoleLimits, selectMemory } from '../memory/select.js';
import {
  sealMessages,
  type BudgetNote,
  type BudgetedMessages,
  type ImagePart,
  type TextPart,
} from '../llm/port.js';
import type { Budget, ModelWindow } from './budget.js';
import type { CarriedResult, Carry } from './carry.js';
import type { ThinkParamKey } from './schemas.js';

export type Progress = {
  /** これから回す回（1始まり） */
  iteration: number;
  remainingIterations?: number;
};

/** 見る役に渡す縮小版 */
export type PreviewImage = {
  key: string;
  data: Uint8Array;
  mediaType: string;
  longEdge: number;
  /** すでにこの画像を渡した LLM 呼び出しの ID（渡した印） */
  sentInCall?: string;
};

/** 記憶ストアから読んだ全項目と、この役の記憶の予算。どれを載せるかは組み立て器が選ぶ */
export type MemoryInput = {
  items: readonly MemoryItem[];
  limits: MemoryRoleLimits;
};

export class InputOverBudgetError extends Error {
  constructor(
    readonly estimatedInputTokens: number,
    readonly inputTokenLimit: number,
  ) {
    super(
      `LLM への入力の必須の部分だけで見積もり ${estimatedInputTokens} が上限 ${inputTokenLimit} を超えている`,
    );
    this.name = 'InputOverBudgetError';
  }
}

export class ImageNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageNotAllowedError';
  }
}

const THINK_SYSTEM = [
  'あなたは Stable Diffusion の生成パラメータを決める役である。',
  '依頼の要点・最良の結果・直近の評価を読み、次の回のパラメータを決める。',
  'prompt と negativePrompt は英語のタグ列で書く。rationale は短く書く。',
].join('\n');

const JUDGE_SYSTEM = [
  'あなたは生成された画像を評価する役である。',
  '画像ごとに、依頼の要点にどれだけ合っているかを 0〜1 で採点し、問題点を短く挙げる。',
  '次の回で変えるべきことを短く書き、意図どおりなら canStop を true にする。',
].join('\n');

/** 入力の1区画。必須でない区画は、入力の上限に入らなければ落とす */
export type Section = { name: string; text: string };

export class SectionWriter {
  readonly notes: BudgetNote[] = [];

  clip(section: string, text: string, limit: number): string {
    const clipped = clipText(text, limit);
    if (clipped.clippedFrom !== undefined) {
      this.notes.push({ kind: 'clipped', section, from: clipped.clippedFrom, to: limit });
    }
    return clipped.text;
  }

  result(
    name: string,
    label: string,
    result: CarriedResult,
    budget: Budget,
    withParams: boolean,
  ): Section {
    const lines = [
      `${label}（${result.iteration}回目・画像${result.imageIndex}・${result.score.toFixed(2)}）:`,
    ];
    if (withParams) {
      const p = result.params;
      if (p.prompt !== undefined) {
        lines.push(`prompt: ${this.clip(`${name}.prompt`, p.prompt, budget.text.prompt)}`);
      }
      if (p.negativePrompt !== undefined) {
        lines.push(
          `negativePrompt: ${this.clip(`${name}.negativePrompt`, p.negativePrompt, budget.text.negativePrompt)}`,
        );
      }
      const numbers = (['seed', 'steps', 'cfg'] as const)
        .filter((k) => p[k] !== undefined)
        .map((k) => `${k}=${p[k]}`);
      if (numbers.length > 0) lines.push(numbers.join(' '));
    }
    const issues = result.issues.slice(0, budget.issuesPerImage);
    if (result.issues.length > issues.length) {
      this.notes.push({
        kind: 'clipped',
        section: `${name}.issues`,
        from: result.issues.length,
        to: issues.length,
      });
    }
    if (issues.length > 0) {
      const clipped = issues.map((s, i) => this.clip(`${name}.issues[${i}]`, s, budget.text.issue));
      lines.push(`問題点: ${clipped.join(' / ')}`);
    }
    lines.push(
      `次に変えること: ${this.clip(`${name}.nextChange`, result.nextChange, budget.text.nextChange)}`,
    );
    return { name, text: lines.join('\n') };
  }
}

/**
 * 必須の区画は必ず入れ、任意の区画は渡した順を優先順位として、入力の上限に入るものだけを入れる。
 */
export function seal(args: {
  system: string;
  writer: SectionWriter;
  required: Section[];
  optional: Section[];
  trailing: Section[];
  images: ImagePart[];
  imageLongEdges: number[];
  window: ModelWindow;
}): BudgetedMessages {
  const { system, writer, required, optional, trailing, images, imageLongEdges, window } = args;
  const inputTokenLimit = window.contextTokens - window.maxOutputTokens;
  const fixedTokens =
    estimateTextTokens(system) +
    [...required, ...trailing].reduce((sum, s) => sum + estimateTextTokens(s.text) + 1, 0) +
    imageLongEdges.reduce((sum, edge) => sum + estimateImageTokens(edge), 0);
  if (fixedTokens > inputTokenLimit) throw new InputOverBudgetError(fixedTokens, inputTokenLimit);

  const packed = packWithinBudget(optional, {
    size: (s) => estimateTextTokens(s.text) + 1,
    limits: { maxSize: inputTokenLimit - fixedTokens },
  });
  const notes: BudgetNote[] = [
    ...writer.notes,
    ...packed.dropped.map(({ item }) => ({
      kind: 'dropped' as const,
      section: item.name,
      reason: '入力の上限に入らない',
    })),
  ];
  const text = [...required, ...packed.included, ...trailing].map((s) => s.text).join('\n');
  const user: (TextPart | ImagePart)[] = [{ type: 'text', text }, ...images];
  return sealMessages(system, user, {
    estimatedInputTokens: fixedTokens + packed.usedSize,
    inputTokenLimit,
    notes,
  });
}

/**
 * 依頼に関係する記憶を、1項目1区画にして返す。記憶の予算で落とした項目は、記録に残すために notes へ入れる。
 */
// 1項目ずつ区画にする: 入力の上限で落とすときも項目の単位で落とし、どれを落としたかを記録に残せるようにするため
function memorySections(
  w: SectionWriter,
  memory: MemoryInput | undefined,
  carry: Carry,
): Section[] {
  if (memory === undefined) return [];
  const { selected, droppedByBudget } = selectMemory(memory.items, carry.intent, memory.limits);
  for (const dropped of droppedByBudget) {
    w.notes.push({
      kind: 'dropped',
      section: `memory[${dropped.item.id}]`,
      reason: describeMemoryDrop(dropped, memory.limits),
    });
  }
  return selected.map((item) => ({ name: `memory[${item.id}]`, text: `好み: ${item.body}` }));
}

function intentSection(w: SectionWriter, carry: Carry, budget: Budget): Section {
  return {
    name: 'intent',
    text: `依頼の要点:\n${w.clip('intent', carry.intent, budget.text.intent)}`,
  };
}

/**
 * 考える役への入力。持ち回す状態だけから組み立てる。
 */
// 過去の回の決定・評価を引数に取らない: 渡せる形にした瞬間、回数に比例して入力が膨らむため
export function buildThinkInput(args: {
  carry: Carry;
  progress: Progress;
  allowed: readonly ThinkParamKey[];
  budget: Budget;
  window: ModelWindow;
  memory?: MemoryInput;
}): BudgetedMessages {
  const { carry, progress, allowed, budget, window, memory } = args;
  const w = new SectionWriter();
  const remaining =
    progress.remainingIterations === undefined ? '' : `（残り ${progress.remainingIterations} 回）`;
  const required: Section[] = [
    intentSection(w, carry, budget),
    {
      name: 'progress',
      text: `これから ${progress.iteration} 回目${remaining}。決めてよいパラメータ: ${allowed.join(', ')}`,
    },
  ];
  const optional: Section[] = [];
  if (carry.best !== undefined) optional.push(w.result('best', '最良', carry.best, budget, true));
  if (carry.latest !== undefined && carry.latest.iteration !== carry.best?.iteration) {
    optional.push(w.result('latest', '直近', carry.latest, budget, true));
  }
  // 記憶は最良・直近より後ろに置く: 入力の上限で削るときは記憶から先に削る（architecture の削る順）
  optional.push(...memorySections(w, memory, carry));
  return seal({
    system: THINK_SYSTEM,
    writer: w,
    required,
    optional,
    trailing: [],
    images: [],
    imageLongEdges: [],
    window,
  });
}

/**
 * 見る役への入力。画像は縮小版を、まだ渡していないものだけ受け付ける。
 */
export function buildJudgeInput(args: {
  carry: Carry;
  images: readonly PreviewImage[];
  budget: Budget;
  window: ModelWindow;
  memory?: MemoryInput;
}): BudgetedMessages {
  const { carry, images, budget, window, memory } = args;
  if (images.length === 0) throw new ImageNotAllowedError('評価する画像が無い');
  if (images.length > budget.imagesPerJudge) {
    throw new ImageNotAllowedError(
      `画像が ${images.length} 枚あり、1回に渡せる ${budget.imagesPerJudge} 枚を超えている`,
    );
  }
  for (const image of images) {
    if (image.sentInCall !== undefined) {
      throw new ImageNotAllowedError(`画像 ${image.key} は呼び出し ${image.sentInCall} で渡し済み`);
    }
    if (image.longEdge > budget.imageLongEdge) {
      throw new ImageNotAllowedError(
        `画像 ${image.key} の長辺 ${image.longEdge}px が上限 ${budget.imageLongEdge}px を超えている（縮小版を渡すこと）`,
      );
    }
  }

  const w = new SectionWriter();
  const optional: Section[] = [];
  // 最良の画像そのものは渡さない: 評価済みの画像は評価のテキストで持ち回す（同じ画像を2回渡さない）
  if (carry.best !== undefined) {
    optional.push(w.result('best', 'これまでの最良', carry.best, budget, false));
  }
  optional.push(...memorySections(w, memory, carry));
  return seal({
    system: JUDGE_SYSTEM,
    writer: w,
    required: [intentSection(w, carry, budget)],
    optional,
    trailing: [{ name: 'images', text: `以下の ${images.length} 枚を、画像0 から順に評価する。` }],
    images: images.map((image) => ({
      type: 'image',
      key: image.key,
      data: image.data,
      mediaType: image.mediaType,
    })),
    imageLongEdges: images.map((image) => image.longEdge),
    window,
  });
}
