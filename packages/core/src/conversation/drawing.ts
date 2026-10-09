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
function candidateNamesOf(key: ParamKey, value: unknown): string[] | undefined {
  if (!(key in CANDIDATE_PARAMS)) return undefined;
  if (typeof value === 'string') return [value];
  if (key === 'loras' && Array.isArray(value)) {
    return value.map((lora) => String((lora as { name?: unknown }).name));
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
  }
  return { ok: true, value: parsed.data };
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
    if (wanted.choices === undefined || allowed === undefined) return undefined;
    return wanted.choices.every((name) => allowed.includes(name))
      ? undefined
      : '人間が選んだ候補の外は選べない';
  }
  const names = candidateNamesOf(key, wanted.value);
  if (names === undefined || allowed === undefined) return undefined;
  return names.every((name) => allowed.includes(name)) ? undefined : '候補に無い値では固定できない';
}

/** 見る役の評価の短い欄 */
export type Judgement = {
  images: readonly { index: number; score: number; issues: readonly string[] }[];
  nextChange: string;
  canStop: boolean;
};

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
      parts.push(
        `最良は ${carry.best.iteration} 回目の ${carry.best.score.toFixed(2)}（${clip(carry.best.issues.join('・'), 80) || '問題なし'}）。`,
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
