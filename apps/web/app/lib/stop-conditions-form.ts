import {
  hasAnyStopCondition,
  type StopConditions,
  type StopConditionsChange,
} from '@drawroid/core';

const MS_PER_MINUTE = 60_000;

// 1 分に満たない上限は秒で書く: 分で書くと「0.08333333333333333 分」になるため（core の describeStopConditions と同じ）
function durationText(ms: number): string {
  return ms < MS_PER_MINUTE ? `${Math.round(ms / 1000)} 秒` : `${ms / MS_PER_MINUTE} 分`;
}

/** 止める条件を、人間が読む短い文の並びにする */
export function describeStopConditions(conditions: StopConditions): string[] {
  return [
    ...(conditions.aiJudgement ? ['AI が意図どおりと判断したら'] : []),
    ...(conditions.maxIterations === undefined ? [] : [`${conditions.maxIterations} 回まで`]),
    ...(conditions.maxImages === undefined ? [] : [`${conditions.maxImages} 枚まで`]),
    ...(conditions.maxDurationMs === undefined
      ? []
      : [`${durationText(conditions.maxDurationMs)}まで`]),
  ];
}

// 入力欄の値は、すべて文字列で持つ: 数値の欄を number で持つと、入力途中の空欄や「-」を表せないため
export interface StopConditionsFormValues {
  aiJudgement: boolean;
  maxIterations: string;
  maxImages: string;
  /** サーバは分ではなくミリ秒で持つ。画面では人間が書きやすい分で扱う */
  maxDurationMinutes: string;
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 投入の画面の初期値。API の既定（AI の判断と 10 回）に揃える */
export const DEFAULT_STOP_CONDITIONS_FORM: StopConditionsFormValues = {
  aiJudgement: true,
  maxIterations: '10',
  maxImages: '',
  maxDurationMinutes: '',
};

export function stopConditionsToForm(conditions: StopConditions): StopConditionsFormValues {
  return {
    aiJudgement: conditions.aiJudgement,
    maxIterations: conditions.maxIterations?.toString() ?? '',
    maxImages: conditions.maxImages?.toString() ?? '',
    maxDurationMinutes:
      conditions.maxDurationMs === undefined
        ? ''
        : (conditions.maxDurationMs / MS_PER_MINUTE).toString(),
  };
}

type Limits = { maxIterations?: number; maxImages?: number; maxDurationMs?: number };

// 数値に直せない文字列は理由付きのエラーにする: 黙って省くと、打ち間違いが「上限なし」に化けて止まらなくなるため
function readLimits(values: StopConditionsFormValues): FormResult<Limits> {
  const limits: Limits = {};
  const integerFields = [
    ['maxIterations', '回数の上限', values.maxIterations],
    ['maxImages', '枚数の上限', values.maxImages],
  ] as const;
  for (const [key, label, text] of integerFields) {
    if (text.trim() === '') continue;
    const value = Number(text.trim());
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, reason: `${label}は 1 以上の整数で書く: ${text}` };
    }
    limits[key] = value;
  }
  if (values.maxDurationMinutes.trim() !== '') {
    const minutes = Number(values.maxDurationMinutes.trim());
    const ms = Math.round(minutes * MS_PER_MINUTE);
    if (!Number.isFinite(minutes) || ms <= 0) {
      return {
        ok: false,
        reason: `時間の上限は 0 より大きい分で書く: ${values.maxDurationMinutes}`,
      };
    }
    limits.maxDurationMs = ms;
  }
  return { ok: true, value: limits };
}

/** 空欄の上限は省く */
export function buildStopConditions(values: StopConditionsFormValues): FormResult<StopConditions> {
  const limits = readLimits(values);
  if (!limits.ok) return limits;
  return { ok: true, value: { aiJudgement: values.aiJudgement, ...limits.value } };
}

/** 読み取れない欄があるときは false にする。その理由は buildStopConditions が別に返す */
export function neverStops(values: StopConditionsFormValues): boolean {
  const built = buildStopConditions(values);
  return built.ok && !hasAnyStopCondition(built.value);
}

// 全部の欄を送り、空欄の上限は null で外す: 変更は「書いた欄だけを変える」ので、省くと人間が消した上限が残ってしまうため
export function buildStopConditionsChange(
  values: StopConditionsFormValues,
): FormResult<StopConditionsChange> {
  const limits = readLimits(values);
  if (!limits.ok) return limits;
  return {
    ok: true,
    value: {
      aiJudgement: values.aiJudgement,
      maxIterations: limits.value.maxIterations ?? null,
      maxImages: limits.value.maxImages ?? null,
      maxDurationMs: limits.value.maxDurationMs ?? null,
    },
  };
}

/** 確定を断る理由。無ければ undefined。読み取れない欄の理由か、止まらない旨 */
export function stopConditionsBlocker(values: StopConditionsFormValues): string | undefined {
  const built = buildStopConditions(values);
  if (!built.ok) return built.reason;
  if (!hasAnyStopCondition(built.value)) {
    return 'この条件では止まらない。AI の判断か、回数・枚数・時間の上限を1つ以上入れる';
  }
  return undefined;
}

export interface ChangedCondition {
  label: string;
  submitted: string;
  current: string;
}

const NONE = 'なし';

/** 投入時と今で値が違う欄だけを返す。走行中の口出しで変わった所を、人間が見分けられるように */
export function changedConditions(
  submitted: StopConditions,
  current: StopConditions,
): ChangedCondition[] {
  const fields: [string, string, string][] = [
    ['AI の判断', submitted.aiJudgement ? 'あり' : NONE, current.aiJudgement ? 'あり' : NONE],
    [
      '回数の上限',
      submitted.maxIterations === undefined ? NONE : `${submitted.maxIterations} 回`,
      current.maxIterations === undefined ? NONE : `${current.maxIterations} 回`,
    ],
    [
      '枚数の上限',
      submitted.maxImages === undefined ? NONE : `${submitted.maxImages} 枚`,
      current.maxImages === undefined ? NONE : `${current.maxImages} 枚`,
    ],
    [
      '時間の上限',
      submitted.maxDurationMs === undefined ? NONE : durationText(submitted.maxDurationMs),
      current.maxDurationMs === undefined ? NONE : durationText(current.maxDurationMs),
    ],
  ];
  return fields
    .filter(([, before, now]) => before !== now)
    .map(([label, before, now]) => ({ label, submitted: before, current: now }));
}
