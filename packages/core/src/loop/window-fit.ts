import { CANDIDATE_KINDS, type CandidateKind } from '../backend.js';
import type { Budgets } from '../budget/settings.js';
import type { ShownCandidate } from '../candidates/select.js';
import type { LlmRole } from '../llm/port.js';
import { PARAM_KEYS } from '../params/param-key.js';
import type { ModelWindow } from './budget.js';
import type { Carry } from './carry.js';
import {
  buildJudgeInput,
  buildRefGistInput,
  buildThinkInput,
  type PreviewImage,
  type ShownCandidates,
} from './inputs.js';

/** ジョブのループで、必須の区画が窓に入るかを確かめる呼び出し */
export type InputStage = 'think' | 'judge' | 'ref-gist';

const STAGE_LABELS: Record<InputStage, string> = {
  think: '考える段',
  judge: '見る段',
  'ref-gist': '参照画像の要点を読む段',
};
const ROLE_LABELS: Record<LlmRole, string> = { think: '考える役', judge: '見る役', talk: '話す役' };

/** 欄ごとの上限を使い切ったときの必須の区画が、その役の窓のうち入力に使える分を超える呼び出し */
export type InputOverflow = {
  role: LlmRole;
  stage: InputStage;
  /** 欄ごとの上限を使い切ったときの、必須の区画の見積もり（トークン） */
  requiredTokens: number;
  /** 窓のうち入力に使える分（文脈の上限 − 出力の分） */
  inputTokenLimit: number;
  window: ModelWindow;
  /** 超えた量（トークン） */
  over: number;
};

// 欄の上限いっぱいに入れる文字: 見積もりで1文字1トークンに数える文字にして、多めに出すため（ASCII は3文字で1トークン）
const WIDE = 'あ';
const wide = (chars: number) => WIDE.repeat(Math.max(0, chars));

// 入力に載る数字の桁: 回数・枚数・時間の残りの上限は無いので、十分に大きい数で多めに見積もる
const LARGE = 99_999;

/**
 * 欄ごとの上限を使い切った入力を本物の組み立てに組ませ、必須の区画（入力の上限に入らなくても削らない区画）の見積もりを、
 * 役の窓のうち入力に使える分と比べる。窓が分からない役（windows に無い役）は比べない。
 */
// 式を別に書かず、本物の組み立てで数える: 組み立て方が変わったとき、ここだけが古い数え方のまま残らないため。
// 任意の区画（記憶・最良・直近・参照画像の要点）は数えない: 入らなければ組み立てが削って記録する区画で、溢れても呼び出しは落ちないため
export function findInputOverflows(
  budgets: Budgets,
  windows: Partial<Record<LlmRole, ModelWindow>>,
): InputOverflow[] {
  const overflows: InputOverflow[] = [];
  const check = (role: LlmRole, stage: InputStage, requiredTokens: number) => {
    const window = windows[role];
    if (window === undefined) return;
    const inputTokenLimit = window.contextTokens - window.maxOutputTokens;
    if (requiredTokens > inputTokenLimit) {
      overflows.push({
        role,
        stage,
        requiredTokens,
        inputTokenLimit,
        window,
        over: requiredTokens - inputTokenLimit,
      });
    }
  };
  if (windows.think !== undefined) {
    check('think', 'think', thinkRequiredTokens(budgets));
    check('think', 'ref-gist', refGistRequiredTokens(budgets));
  }
  if (windows.judge !== undefined) check('judge', 'judge', judgeRequiredTokens(budgets));
  return overflows;
}

/** 保存を断る理由・起動時に知らせる1行に使う文 */
export function describeInputOverflow(overflow: InputOverflow): string {
  const { role, stage, requiredTokens, inputTokenLimit, window, over } = overflow;
  return (
    `${ROLE_LABELS[role]}の${STAGE_LABELS[stage]}は、予算の欄ごとの上限を使い切ると、削れない部分だけで ${requiredTokens} トークンになり、` +
    `${ROLE_LABELS[role]}の窓（文脈の上限 ${window.contextTokens} − 出力の分 ${window.maxOutputTokens} = 入力に使える ${inputTokenLimit} トークン）を ${over} トークン超える`
  );
}

// 必須の区画だけの入力を組む窓: 見積もりを読むためだけに組むので、上限で落ちないようにする
const UNBOUNDED: ModelWindow = { contextTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: 0 };

function fullCarry(budgets: Budgets): Carry {
  return { intent: wide(budgets.text.intent), completedIterations: 0 };
}

function fullInterventions(budgets: Budgets) {
  const { maxCount, maxSize, textEach } = budgets.interventions;
  const included = [];
  let left = maxSize;
  for (let n = 0; n < maxCount && left > 0; n += 1) {
    const chars = Math.min(textEach, left);
    included.push({ interventionId: `i${n}`, text: wide(chars) });
    left -= chars;
  }
  return { included, carried: [], notes: [] };
}

/** 候補の種類ごとに、件数と文字数の上限いっぱいの候補。説明を付けると括弧の分だけ長くなるので、どれにも付ける */
function fullCandidates(budgets: Budgets): ShownCandidates {
  const { maxCount, maxSize } = budgets.candidates;
  const size = maxSize ?? 0;
  const count = Math.max(1, Math.min(maxCount ?? size, Math.floor(size / 2)));
  const each = Math.floor(size / count);
  const shown: ShownCandidate[] = Array.from({ length: count }, (_, n) => ({
    name: wide(1),
    note: wide((n === count - 1 ? size - each * (count - 1) : each) - 1),
  }));
  const byKind: Partial<Record<CandidateKind, readonly ShownCandidate[]>> = {};
  for (const kind of CANDIDATE_KINDS) byKind[kind] = shown;
  return { shown: byKind, dropped: [], notesDropped: [] };
}

function thinkRequiredTokens(budgets: Budgets): number {
  return buildThinkInput({
    carry: fullCarry(budgets),
    progress: {
      iteration: LARGE,
      remainingIterations: LARGE,
      remainingImages: LARGE,
      remainingMs: LARGE * 60_000,
    },
    allowed: PARAM_KEYS,
    budget: budgets,
    window: UNBOUNDED,
    interventions: fullInterventions(budgets),
    candidates: fullCandidates(budgets),
  }).report.estimatedInputTokens;
}

function preview(key: string, budgets: Budgets): PreviewImage {
  return { key, data: new Uint8Array(), mediaType: 'image/webp', longEdge: budgets.imageLongEdge };
}

function judgeRequiredTokens(budgets: Budgets): number {
  return buildJudgeInput({
    carry: fullCarry(budgets),
    images: Array.from({ length: budgets.imagesPerJudge }, (_, n) => preview(`1-${n}`, budgets)),
    budget: budgets,
    window: UNBOUNDED,
  }).report.estimatedInputTokens;
}

function refGistRequiredTokens(budgets: Budgets): number {
  return buildRefGistInput({
    carry: fullCarry(budgets),
    image: preview('ref', budgets),
    note: wide(budgets.references.noteChars),
    budget: budgets,
    limits: budgets.references,
    window: UNBOUNDED,
  }).report.estimatedInputTokens;
}
