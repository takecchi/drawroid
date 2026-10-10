import { z } from 'zod';

import { DEFAULT_CANDIDATE_LIMITS } from '../loop/iteration-permissions.js';
import { DEFAULT_BUDGET, type Budget } from '../loop/budget.js';
import { DEFAULT_DISTILL_BUDGET, type DistillBudget } from '../memory/distill/budget.js';
import { DEFAULT_MEMORY_LIMITS, type MemoryLimits } from '../memory/limits.js';
import {
  DEFAULT_INTERVENTION_LIMITS,
  type InterventionLimits,
} from '../intervention/intervention.js';
import { DEFAULT_REFERENCE_LIMITS, type ReferenceLimits } from '../reference/reference.js';
import { DEFAULT_TALK_LIMITS, type TalkLimits } from '../conversation/talk/limits.js';
import type { PackLimits } from './pack.js';

/**
 * 1つのジョブが使う予算の全部。Budget を受ける関数へそのまま渡せるように、Budget の欄に平らに足してある。
 */
export type Budgets = Budget & {
  candidates: PackLimits;
  interventions: InterventionLimits;
  references: ReferenceLimits;
  memory: MemoryLimits;
  distill: DistillBudget;
  /** 会話の話す役。ジョブには効かない */
  talk: TalkLimits;
};

export const DEFAULT_BUDGETS: Budgets = {
  ...DEFAULT_BUDGET,
  candidates: DEFAULT_CANDIDATE_LIMITS,
  interventions: DEFAULT_INTERVENTION_LIMITS,
  references: DEFAULT_REFERENCE_LIMITS,
  memory: DEFAULT_MEMORY_LIMITS,
  distill: DEFAULT_DISTILL_BUDGET,
  talk: DEFAULT_TALK_LIMITS,
};

export type BudgetOverrides = DeepPartial<Budgets>;

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// 上限は既定値の20倍: 打ち間違いで入力が窓を食い尽くすのを防ぎつつ、既定を大きく広げたい要望は通すため
const MAX_FACTOR = 20;
const count = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(fallback * MAX_FACTOR);

const IMAGE_LONG_EDGE_MIN = 128;
const imageLongEdge = z.number().int().min(IMAGE_LONG_EDGE_MIN).max(1536);
const imagesPerJudge = z.number().int().min(1).max(8);

/** 欄（path は欄の道筋、例: text.intent）に保存できる、いちばん小さい値 */
export function budgetLeafMinimum(path: string): number {
  return path === 'imageLongEdge' ? IMAGE_LONG_EDGE_MIN : 1;
}

/** 既定値の形から、全欄必須の木と、深い partial の木の両方を作る。どちらも未知の鍵は拒む */
function treeOf(
  defaults: Record<string, unknown>,
  partial: boolean,
  special: Record<string, z.ZodType> = {},
  strict = true,
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    shape[key] =
      special[key] ??
      (typeof fallback === 'number'
        ? count(fallback)
        : treeOf(fallback as Record<string, unknown>, partial, {}, strict));
  }
  const object = strict ? z.strictObject(shape) : z.looseObject(shape);
  return partial ? object.partial() : object;
}

const specialLeaves = { imageLongEdge, imagesPerJudge };

/** job.json に写す、解決済みの予算。全欄が要る */
export const budgetsSchema = treeOf(DEFAULT_BUDGETS, false, specialLeaves) as z.ZodType<Budgets>;

/**
 * job.json に写した予算を読むときの形。書かれた欄だけを確かめ、足りない欄は読む側が既定で埋める。
 */
// 全欄必須・未知の鍵を拒む形にしない: あとで予算に欄を足したり減らしたりすると、それより前に投入したジョブの job.json が読めなくなるため
export const storedBudgetsSchema = treeOf(
  DEFAULT_BUDGETS,
  true,
  specialLeaves,
  false,
) as z.ZodType<BudgetOverrides>;

/** config.json の budgets と PUT の本文。書いた欄だけを、範囲を確かめて受ける */
export const budgetOverridesSchema = treeOf(
  DEFAULT_BUDGETS,
  true,
  specialLeaves,
) as z.ZodType<BudgetOverrides>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function overlay(base: unknown, overrides: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overrides)) return overrides ?? base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = overlay(base[key], value);
  }
  return merged;
}

/** 書いた欄だけを既定に重ねる。入れ子は何段でも深く重ねる */
export function resolveBudgets(overrides: BudgetOverrides): Budgets {
  return overlay(DEFAULT_BUDGETS, overrides) as Budgets;
}

/** 読めなかった予算の欄。path は欄の道筋（例: text.prompt）で、'*' なら budgets 全体が読めなかった */
export interface InvalidBudget {
  path: string;
  reason: string;
}

function removeAt(target: Record<string, unknown>, path: readonly PropertyKey[]): void {
  let node: unknown = target;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node)) return;
    node = node[key as string];
  }
  if (isPlainObject(node)) delete node[path.at(-1) as string];
}

/**
 * config.json の budgets を、欄ごとに読む。読めない欄（範囲の外・形の違い・知らない欄）は外して、理由とともに返す。
 * 外した欄は書いていないのと同じなので、既定に戻る。
 */
// 1 か所の書き損じで投入を止めない: 許可（readPermissionOverrides）と同じ作り。読めない欄はログと設定の口で知らせる
export function readBudgetOverrides(raw: unknown): {
  overrides: BudgetOverrides;
  invalid: InvalidBudget[];
} {
  if (raw === undefined) return { overrides: {}, invalid: [] };
  if (!isPlainObject(raw)) {
    return { overrides: {}, invalid: [{ path: '*', reason: '予算が、欄の集まりになっていない' }] };
  }
  const draft = structuredClone(raw);
  const invalid: InvalidBudget[] = [];
  // 外すたびに読み直す: 外すと、同じ欄の中の別の誤りが見えるようになることがあるため。欄の数で回数は締まる
  for (;;) {
    const parsed = budgetOverridesSchema.safeParse(draft);
    if (parsed.success) return { overrides: parsed.data, invalid };
    const before = invalid.length;
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) {
          invalid.push({ path: [...issue.path, key].join('.'), reason: '知らない欄' });
          removeAt(draft, [...issue.path, key]);
        }
        continue;
      }
      if (issue.path.length === 0) break;
      invalid.push({ path: issue.path.join('.'), reason: issue.message });
      removeAt(draft, issue.path);
    }
    // 外せる欄が無いのに読めない: 全体を外す
    if (invalid.length === before) {
      return { overrides: {}, invalid: [...invalid, { path: '*', reason: '予算が読めない' }] };
    }
  }
}
