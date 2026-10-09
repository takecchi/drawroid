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
  // 絞り込み（choices）はモデルにだけ効く。前処理は controlnetModule を併せて見せる（EXTRA_CANDIDATE_KINDS）
  controlnet: 'controlnetModel',
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

// 1つのパラメータが2種類の候補から選ぶもの。choices は主の種類にだけ効かせる:
// 名前の種類が違うので、モデル名の絞り込みを前処理の名前に当てると前処理が全部消えるため
const EXTRA_CANDIDATE_KINDS: Partial<Record<ParamKey, CandidateKind>> = {
  controlnet: 'controlnetModule',
};

/** AI に任せたパラメータのうち、候補から選ぶものの候補の種類 */
export function candidateKindsToList(permissions: Permissions): CandidateKind[] {
  return (Object.entries(CANDIDATE_PARAMS) as [ParamKey, CandidateKind][])
    .filter(([key]) => permissions[key].mode === 'auto')
    .flatMap(([key, kind]) => [
      kind,
      ...(EXTRA_CANDIDATE_KINDS[key] ? [EXTRA_CANDIDATE_KINDS[key]] : []),
    ]);
}

/**
 * 人間が候補に付けた短い説明（候補の名前 → 説明）。読めなかったときは、説明なしで理由を problem に持つ。
 */
export type CandidateNotes = {
  notes: ReadonlyMap<string, string>;
  problem?: string;
};

/**
 * その回に考える役へ見せる候補を、許可（人間の絞り込み）と予算で選ぶ。
 */
export function shownCandidatesFor(args: {
  permissions: Permissions;
  lists: Partial<Record<CandidateKind, readonly Candidate[]>>;
  notes: CandidateNotes;
  requestGist: string;
  limits: PackLimits;
}): ShownCandidates {
  const result: ShownCandidates = {
    shown: {},
    dropped: [],
    notesDropped: [],
    ...(args.notes.problem === undefined ? {} : { notesProblem: args.notes.problem }),
  };
  for (const [key, kind] of Object.entries(CANDIDATE_PARAMS) as [ParamKey, CandidateKind][]) {
    const permission = args.permissions[key];
    if (permission.mode !== 'auto') continue;
    const extra = EXTRA_CANDIDATE_KINDS[key];
    const kinds: [CandidateKind, readonly string[] | undefined][] = [[kind, permission.choices]];
    if (extra !== undefined) kinds.push([extra, undefined]);
    for (const [shownKind, choices] of kinds) {
      const selection = selectCandidates(
        args.lists[shownKind] ?? [],
        choices,
        args.notes.notes,
        args.requestGist,
        args.limits,
      );
      result.shown[shownKind] = selection.shown;
      result.dropped.push(
        ...selection.droppedByBudget.map((d) => ({
          kind: shownKind,
          name: d.item,
          reason: d.reason,
        })),
      );
      result.notesDropped.push(
        ...selection.notesDroppedByBudget.map((d) => ({ kind: shownKind, name: d.item })),
      );
    }
  }
  return result;
}
