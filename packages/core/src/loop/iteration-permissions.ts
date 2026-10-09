import type { Candidate, CandidateKind } from '../backend.js';
import type { PackLimits } from '../budget/pack.js';
import { selectCandidates } from '../candidates/select.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import type { Permissions } from '../permissions/permission.js';
import type { ShownCandidates } from './inputs.js';

/** 候補から選ぶパラメータと、その候補の種類 */
export const CANDIDATE_PARAMS = {
  checkpoint: 'checkpoint',
  vae: 'vae',
  loras: 'lora',
  sampler: 'sampler',
  scheduler: 'scheduler',
  hiresFix: 'upscaler',
} as const satisfies Partial<Record<ParamKey, CandidateKind>>;

// 値は仮置き。設定（config.json の budgets）の既定値として、実測で見直す
export const DEFAULT_CANDIDATE_LIMITS: PackLimits = { maxCount: 20, maxSize: 600 };

const M2_AUTO: readonly ParamKey[] = ['prompt', 'negativePrompt', 'seed', 'steps', 'cfgScale'];

/**
 * M2 の可動範囲の許可。プロンプト・ネガティブ・seed・steps・CFG を AI に任せ、大きさは固定し、ほかは使わない。
 * 全体の既定の許可を設定に書かないときの土台になる。
 */
export function basicPermissions(size: { width: number; height: number }): Permissions {
  return Object.fromEntries(
    PARAM_KEYS.map((key) => [
      key,
      M2_AUTO.includes(key)
        ? { mode: 'auto' }
        : key === 'width' || key === 'height'
          ? { mode: 'fixed', value: size[key] }
          : { mode: 'off' },
    ]),
  ) as Permissions;
}

/** AI に任せたパラメータのうち、候補から選ぶものの候補の種類 */
export function candidateKindsToList(permissions: Permissions): CandidateKind[] {
  return (Object.entries(CANDIDATE_PARAMS) as [ParamKey, CandidateKind][])
    .filter(([key]) => permissions[key].mode === 'auto')
    .map(([, kind]) => kind);
}

/**
 * その回に考える役へ見せる候補を、許可（人間の絞り込み）と予算で選ぶ。
 */
export function shownCandidatesFor(args: {
  permissions: Permissions;
  lists: Partial<Record<CandidateKind, readonly Candidate[]>>;
  notes: ReadonlyMap<string, string>;
  requestGist: string;
  limits: PackLimits;
}): ShownCandidates {
  const result: ShownCandidates = { shown: {}, dropped: [], notesDropped: [] };
  for (const [key, kind] of Object.entries(CANDIDATE_PARAMS) as [ParamKey, CandidateKind][]) {
    const permission = args.permissions[key];
    if (permission.mode !== 'auto') continue;
    const selection = selectCandidates(
      args.lists[kind] ?? [],
      permission.choices,
      args.notes,
      args.requestGist,
      args.limits,
    );
    result.shown[kind] = selection.shown;
    result.dropped.push(
      ...selection.droppedByBudget.map((d) => ({ kind, name: d.item, reason: d.reason })),
    );
    result.notesDropped.push(
      ...selection.notesDroppedByBudget.map((d) => ({ kind, name: d.item })),
    );
  }
  return result;
}
