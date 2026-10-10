import { z } from 'zod';

import type { CandidateKind } from '../backend.js';
import type { JobStore } from '../job/store.js';
import type { JobState } from '../job/types.js';
import { CANDIDATE_PARAMS } from '../loop/iteration-permissions.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import {
  permissionOverridesSchema,
  type Permission,
  type Permissions,
} from '../permissions/permission.js';
import type { ConversationEvent } from './events.js';

/** 人間に見せるパラメータの名前（話す役への理由・画面で同じ言葉を使う） */
export const PARAM_LABELS: Record<ParamKey, string> = {
  prompt: 'プロンプト',
  negativePrompt: 'ネガティブプロンプト',
  checkpoint: 'checkpoint',
  vae: 'VAE',
  loras: 'LoRA',
  sampler: 'サンプラー',
  scheduler: 'スケジューラー',
  steps: 'steps',
  cfgScale: 'CFG scale',
  seed: 'seed',
  width: '幅',
  height: '高さ',
  hiresFix: 'Hires. fix',
  img2img: 'img2img',
  inpaint: 'inpaint',
  controlnet: 'ControlNet',
};

const labelOf = (key: PropertyKey) =>
  (PARAM_KEYS as readonly PropertyKey[]).includes(key)
    ? PARAM_LABELS[key as ParamKey]
    : String(key);

/** 候補から選ぶパラメータの値が使う候補の名前。候補から選ばないパラメータは undefined */
export function candidateNamesOf(key: ParamKey, value: unknown): string[] | undefined {
  if (!(key in CANDIDATE_PARAMS)) return undefined;
  if (typeof value === 'string') return [value];
  if (key === 'loras' && Array.isArray(value)) {
    return value.map((lora) => String((lora as { name?: unknown }).name));
  }
  if (key === 'controlnet' && Array.isArray(value)) {
    return value.map((unit) => String((unit as { model?: unknown }).model));
  }
  if (key === 'hiresFix' && typeof value === 'object' && value !== null) {
    return [String((value as { upscaler?: unknown }).upscaler)];
  }
  return [];
}

export type NarrowResult =
  { ok: true; value: Partial<Permissions> } | { ok: false; reason: string };

/**
 * 話す役が start_drawing で求めた許可が、人間の許可を狭めるだけかを確かめる。広げるもの・人間の決めたことを変えるものは断る。
 * 狭めるとは、AI に任せたものを使わないにするか、その候補の中の値で固定するか、候補を絞ることだけ。
 * lists は、候補の種類ごとに、バックエンドが今持っている候補の名前（人間が候補を絞っていないときの範囲）。
 */
// 広げる経路を作らない: 話す役の言葉で、人間が決めた許可を迂回させないため（north_star の問い5）
export function narrowPermissions(
  human: Permissions,
  requested: unknown,
  lists: Partial<Record<CandidateKind, readonly string[]>>,
): NarrowResult {
  const parsed = permissionOverridesSchema.safeParse(requested);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const rest = issue?.path.slice(1).join('.') ?? '';
    return {
      ok: false,
      reason: `${key === undefined ? '許可' : labelOf(key)}${rest === '' ? '' : ` の ${rest}`}: ${issue?.message ?? '形が違う'}`,
    };
  }
  for (const [key, wanted] of Object.entries(parsed.data) as [ParamKey, Permission][]) {
    const refusal = refuseWidening(key, human[key], wanted, lists);
    if (refusal !== undefined) return { ok: false, reason: `${PARAM_LABELS[key]}: ${refusal}` };
    if (key === 'hiresFix' && wanted.mode === 'fixed') {
      const second = refuseSecondPassWidening(human, wanted.value, lists);
      if (second !== undefined) return { ok: false, reason: second };
    }
  }
  return { ok: true, value: parsed.data };
}

/** Hires. fix の二段目が自分で持てる、一段目と同じ意味の欄 */
const SECOND_PASS_KEYS = [
  'checkpoint',
  'sampler',
  'scheduler',
  'prompt',
  'negativePrompt',
  'cfgScale',
] as const satisfies readonly ParamKey[];

/**
 * 固定した Hires. fix の二段目の欄を、一段目の同じパラメータを固定する求めとして確かめる。
 */
// 二段目の欄も人間の許可に照らす: 照らさないと、checkpoint を候補で絞っていても、二段目の checkpoint に候補の外を書けば
// その checkpoint で描けてしまい、Hires. fix を通して人間の許可を迂回できるため（north_star の問い5）
function refuseSecondPassWidening(
  human: Permissions,
  value: unknown,
  lists: Partial<Record<CandidateKind, readonly string[]>>,
): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const key of SECOND_PASS_KEYS) {
    const named = (value as Record<string, unknown>)[key];
    if (named === undefined) continue;
    const refusal = refuseWidening(key, human[key], { mode: 'fixed', value: named }, lists);
    if (refusal !== undefined) {
      return `${PARAM_LABELS.hiresFix} の二段目の${PARAM_LABELS[key]}: ${refusal}`;
    }
  }
  return undefined;
}

function refuseWidening(
  key: ParamKey,
  human: Permission,
  wanted: Permission,
  lists: Partial<Record<CandidateKind, readonly string[]>>,
): string | undefined {
  if (human.mode === 'fixed') {
    return wanted.mode === 'fixed' && JSON.stringify(wanted.value) === JSON.stringify(human.value)
      ? undefined
      : '人間が固定した値は変えられない';
  }
  if (human.mode === 'off') {
    return wanted.mode === 'off' ? undefined : '人間が使わないにしたものは使えない';
  }
  if (wanted.mode === 'off') return undefined;
  const kind = (CANDIDATE_PARAMS as Partial<Record<ParamKey, CandidateKind>>)[key];
  const allowed = human.choices ?? (kind === undefined ? undefined : lists[kind]);
  if (wanted.mode === 'auto') {
    // 絞り込みを省いた上書きも断る: ジョブの上書きは欄ごと置き換わるので、人間が選んだ候補が消え、全候補に広がるため
    if (wanted.choices === undefined) {
      return human.choices === undefined ? undefined : '人間が選んだ候補の絞り込みは外せない';
    }
    if (allowed === undefined) return undefined;
    return wanted.choices.every((name) => allowed.includes(name))
      ? undefined
      : '人間が選んだ候補の外は選べない';
  }
  const overLimit = refuseOverSafetyLimit(key, wanted.value);
  if (overLimit !== undefined) return overLimit;
  const names = candidateNamesOf(key, wanted.value);
  if (names === undefined || allowed === undefined) return undefined;
  return names.every((name) => allowed.includes(name)) ? undefined : '候補に無い値では固定できない';
}

/** 話す役が固定できる数の上限 */
const FIXED_NUMBER_LIMITS: Partial<Record<ParamKey, number>> = {
  steps: 150,
  width: 4096,
  height: 4096,
};
/** 話す役が固定できる文の文字数の上限 */
const FIXED_TEXT_LIMIT = 4000;
const FIXED_TEXT_KEYS: readonly ParamKey[] = ['prompt', 'negativePrompt'];
/** 話す役が固定できる Hires. fix の倍率の上限 */
const FIXED_HIRES_SCALE_LIMIT = 4;

/**
 * 話す役が AI 任せのものを固定するときの、安全のための上限。人間が固定した値には掛けない（その前の確かめで同じ値だけが通る）。
 */
// 上限を置く: 生成の要求の形は下限しか持たないので、話す役の言葉だけで steps や大きさを桁違いに固定され、バックエンドを
// 長く占められるため。考える役は出力のスキーマで steps・倍率を絞るが、話す役の固定はそのスキーマを通らない
function refuseOverSafetyLimit(key: ParamKey, value: unknown): string | undefined {
  const numberLimit = FIXED_NUMBER_LIMITS[key];
  if (numberLimit !== undefined && typeof value === 'number' && value > numberLimit) {
    return `上限（${numberLimit}）を超える値では固定できない`;
  }
  if (
    FIXED_TEXT_KEYS.includes(key) &&
    typeof value === 'string' &&
    value.length > FIXED_TEXT_LIMIT
  ) {
    return `文字数の上限（${FIXED_TEXT_LIMIT} 文字）を超える値では固定できない`;
  }
  if (key === 'hiresFix' && typeof value === 'object' && value !== null) {
    const { scale } = value as { scale?: unknown };
    if (typeof scale === 'number' && scale > FIXED_HIRES_SCALE_LIMIT) {
      return `倍率の上限（${FIXED_HIRES_SCALE_LIMIT}）を超える値では固定できない`;
    }
  }
  return undefined;
}

/** 見る役の評価の短い欄 */
export type Judgement = {
  images: readonly { index: number; score: number; issues: readonly string[] }[];
  nextChange: string;
  canStop: boolean;
};

/**
 * 話す役から見える画像の数え方。回も枚目も 1 から数える（要約・評価の文・ツールの入力のどれも同じ）。
 * 置き場所・API・画面の中の画像（ImageRef の index）は 0 から数え、話す役との境目でだけ読み替える。
 */
// 話す役に 0 から数える数を見せない: 要約の「2枚目」を小さなモデルが 0 から数える欄にそのまま渡し、
// 範囲の中で1つずれた別の画像を黙って選んでいたため。人の言い方（「2枚目」）も画面（「画像 2 番」）も 1 から数える
export function talkImageLabel(image: { iteration: number; index: number }): string {
  return `${image.iteration} 回目の ${image.index + 1}枚目`;
}

/** 話す役のツールが画像を指す欄。0 は断る（0 から数えた数を渡されたときに、黙って別の画像にしないため） */
export const talkImageNumberSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('その回の何枚目か（1 から。要約や評価の「N枚目」と同じ数え方）。省けば 1枚目');

/** talkImageNumberSchema の数を、置き場所の画像の index（0 から）にする */
export function indexOfTalkImageNumber(number: number | undefined): number {
  return (number ?? 1) - 1;
}

/**
 * 見る役の短い欄（点数・問題点・次に変えること・止めてよいか）を、決まった型の文にする。
 */
// 見る役に「人間向けの一言」の欄を足さない: 出力トークンが増えるため（設計の推奨 6）
export function describeJudgement(judgement: Judgement): string {
  const images = judgement.images
    .map(
      (image) =>
        `${image.index + 1}枚目は ${image.score.toFixed(2)}（${image.issues.length === 0 ? '問題なし' : image.issues.join('・')}）`,
    )
    .join('、');
  const next = judgement.canStop
    ? '意図どおりなので、止めてよい。'
    : judgement.nextChange.trim() === ''
      ? ''
      : `次は「${judgement.nextChange.trim()}」。`;
  return `${images}。${next}`;
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1))}…`;
}

/**
 * 話す役へ渡す、会話のジョブの要約。持ち回す状態（carry）の短い欄と状態だけから作り、文字数の上限に収める。
 * 回の中身（決めたパラメータの全文・画像）は渡さない。
 */
// 回数に比例して膨らまないように、carry の固定の欄だけを使う（原則2）
export function summarizeJobForTalk(
  jobId: string,
  state: JobState,
  limits: { chars: number },
): string {
  const status =
    state.status === 'stopped'
      ? `止まった（${state.reason.kind}${state.reason.detail === undefined ? '' : `: ${state.reason.detail}`}）`
      : state.status === 'running'
        ? '走っている'
        : '順番を待っている';
  const carry = state.carry;
  const parts = [`ジョブ ${jobId} は${status}。`];
  if (carry !== undefined) {
    parts.push(`${carry.completedIterations} 回済み。`);
    if (carry.best !== undefined) {
      const best = carry.best;
      const image = talkImageLabel({ iteration: best.iteration, index: best.imageIndex });
      const issues = clip(best.issues.join('・'), 80) || '問題なし';
      // 人が選んで止まったときは、最良が選ばれた画像になる（選択による評価は必ず最良になる）。点数（選択では 1）は出さず、選んだと書く
      parts.push(
        state.status === 'stopped' && state.reason.kind === 'adopted'
          ? `人が選んだのは ${image}（${issues}）。`
          : `最良は ${image}で ${best.score.toFixed(2)}（${issues}）。`,
      );
    }
    if (carry.latest !== undefined && carry.latest.nextChange.trim() !== '') {
      parts.push(`次に変えること: ${clip(carry.latest.nextChange.trim(), 120)}。`);
    }
    parts.push(`依頼の要点: ${carry.intent}`);
  }
  return clip(parts.join(''), limits.chars);
}

/**
 * 会話の実行器（TalkRunner）の jobSummary に渡す関数を作る。会話の最後のジョブ（いちばん新しい job.started）の
 * 状態を、summarizeJobForTalk の短い文にする。会話にジョブが無ければ undefined。
 */
export function jobSummaryFor(deps: {
  jobs: Pick<JobStore, 'readState'>;
  /** 要約の文字数の上限（予算の talk.jobChars） */
  chars: () => Promise<number>;
}): (events: readonly ConversationEvent[]) => Promise<string | undefined> {
  return async (events) => {
    const started = events.findLast((event) => event.type === 'job.started');
    if (started === undefined || started.type !== 'job.started') return undefined;
    const state = await deps.jobs.readState(started.jobId);
    return summarizeJobForTalk(started.jobId, state, { chars: await deps.chars() });
  };
}
