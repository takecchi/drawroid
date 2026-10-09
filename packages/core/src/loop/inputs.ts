import { clipText, estimateImageTokens, estimateTextTokens } from '../budget/estimate.js';
import { packWithinBudget } from '../budget/pack.js';
import type { InterventionPlan } from '../intervention/plan.js';
import type { ReferenceLimits } from '../reference/reference.js';
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
type Section = { name: string; text: string };

class SectionWriter {
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
function seal(args: {
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

/** 口出しの原文。AI の判断の区画とは見出しで分け、人間の指示として渡す */
function interventionSection(w: SectionWriter, plan: InterventionPlan | undefined): Section[] {
  if (plan === undefined) return [];
  w.notes.push(...plan.notes);
  if (plan.included.length === 0) return [];
  const lines = plan.included.map((planned) => `- ${planned.text}`);
  return [{ name: 'interventions', text: `人間の指示:\n${lines.join('\n')}` }];
}

/** 参照画像の要点。量は carry に入れるときに件数と文字数で締めてある */
function referenceSections(carry: Carry): Section[] {
  const references = carry.references ?? [];
  if (references.length === 0) return [];
  const lines = references.map((reference) => `- ${reference.gist}`);
  return [{ name: 'references', text: `参照画像の要点:\n${lines.join('\n')}` }];
}

/** 渡してよい画像か。縮小版で、まだどの呼び出しにも渡していないこと */
function assertSendable(image: PreviewImage, budget: Budget): void {
  if (image.sentInCall !== undefined) {
    throw new ImageNotAllowedError(`画像 ${image.key} は呼び出し ${image.sentInCall} で渡し済み`);
  }
  if (image.longEdge > budget.imageLongEdge) {
    throw new ImageNotAllowedError(
      `画像 ${image.key} の長辺 ${image.longEdge}px が上限 ${budget.imageLongEdge}px を超えている（縮小版を渡すこと）`,
    );
  }
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
  /** planInterventions の結果。載せた口出しは必須の区画にする */
  interventions?: InterventionPlan;
}): BudgetedMessages {
  const { carry, progress, allowed, budget, window, interventions } = args;
  const w = new SectionWriter();
  const remaining =
    progress.remainingIterations === undefined ? '' : `（残り ${progress.remainingIterations} 回）`;
  const required: Section[] = [
    intentSection(w, carry, budget),
    {
      name: 'progress',
      text: `これから ${progress.iteration} 回目${remaining}。決めてよいパラメータ: ${allowed.join(', ')}`,
    },
    // 口出しは入力の上限で削らない: 人間の指示が黙って消えないように。量は planInterventions の上限で締めてある
    ...interventionSection(w, interventions),
  ];
  const optional: Section[] = [...referenceSections(carry)];
  if (carry.best !== undefined) optional.push(w.result('best', '最良', carry.best, budget, true));
  if (carry.latest !== undefined && carry.latest.iteration !== carry.best?.iteration) {
    optional.push(w.result('latest', '直近', carry.latest, budget, true));
  }
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
}): BudgetedMessages {
  const { carry, images, budget, window } = args;
  if (images.length === 0) throw new ImageNotAllowedError('評価する画像が無い');
  if (images.length > budget.imagesPerJudge) {
    throw new ImageNotAllowedError(
      `画像が ${images.length} 枚あり、1回に渡せる ${budget.imagesPerJudge} 枚を超えている`,
    );
  }
  for (const image of images) assertSendable(image, budget);

  const w = new SectionWriter();
  // 参照画像そのものは渡さない: 届いたときに ref-gist で1度だけ見せ、以後は要点のテキストで持ち回す
  const optional: Section[] = [...referenceSections(carry)];
  // 最良の画像そのものは渡さない: 評価済みの画像は評価のテキストで持ち回す（同じ画像を2回渡さない）
  if (carry.best !== undefined) {
    optional.push(w.result('best', 'これまでの最良', carry.best, budget, false));
  }
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

const REF_GIST_SYSTEM = [
  'あなたは人間が添えた参照画像を読む役である。',
  '依頼の要点に照らして、この画像から生成に活かすべきこと（構図・色・画風・服装など）を短い日本語で書く。',
].join('\n');

/**
 * 参照画像の要点を書かせる入力（ref-gist）。参照画像1枚の縮小版を、まだ渡していないときだけ受け付ける。
 */
export function buildRefGistInput(args: {
  carry: Carry;
  image: PreviewImage;
  /** 人間が添えた用途の言葉 */
  note?: string;
  budget: Budget;
  limits: ReferenceLimits;
  window: ModelWindow;
}): BudgetedMessages {
  const { carry, image, note, budget, limits, window } = args;
  assertSendable(image, budget);
  const w = new SectionWriter();
  const required = [intentSection(w, carry, budget)];
  if (note !== undefined) {
    required.push({
      name: 'note',
      text: `人間が添えた用途: ${w.clip('note', note, limits.noteChars)}`,
    });
  }
  return seal({
    system: REF_GIST_SYSTEM,
    writer: w,
    required,
    optional: [],
    trailing: [{ name: 'image', text: '以下の参照画像の要点を書く。' }],
    images: [{ type: 'image', key: image.key, data: image.data, mediaType: image.mediaType }],
    imageLongEdges: [image.longEdge],
    window,
  });
}
