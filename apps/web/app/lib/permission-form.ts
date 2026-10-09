import {
  CANDIDATE_PARAMS,
  generationRequestSchema,
  PARAM_KEYS,
  REQUIRED_PARAM_KEYS,
  type CandidateKind,
  type ParamKey,
  type Permission,
} from '@drawroid/core';
import type { PermissionOverridesInput } from '@drawroid/swr';

import type { FormResult } from './stop-conditions-form';

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

/** 固定の値の書き方。json は構造を持つ欄（JSON で書く） */
export type FixedValueKind = 'text' | 'number' | 'json';

const FIXED_VALUE_KINDS: Record<ParamKey, FixedValueKind> = {
  prompt: 'text',
  negativePrompt: 'text',
  checkpoint: 'text',
  vae: 'text',
  sampler: 'text',
  scheduler: 'text',
  steps: 'number',
  cfgScale: 'number',
  seed: 'number',
  width: 'number',
  height: 'number',
  loras: 'json',
  hiresFix: 'json',
  img2img: 'json',
  inpaint: 'json',
  controlnet: 'json',
};

export function fixedValueKindOf(key: ParamKey): FixedValueKind {
  return FIXED_VALUE_KINDS[key];
}

export function isRequired(key: ParamKey): boolean {
  return (REQUIRED_PARAM_KEYS as readonly ParamKey[]).includes(key);
}

/** 候補から選ぶパラメータなら、その候補の種類 */
export function candidateKindOf(key: ParamKey): CandidateKind | undefined {
  return (CANDIDATE_PARAMS as Partial<Record<ParamKey, CandidateKind>>)[key];
}

/** 画面の1行。default は書かない（土台のまま）。choices が undefined なら候補を絞らない */
export interface Row {
  mode: 'default' | Permission['mode'];
  choices: string[] | undefined;
  fixedText: string;
}
export type Rows = Record<ParamKey, Row>;

function formatFixed(key: ParamKey, value: unknown): string {
  if (fixedValueKindOf(key) === 'json') return JSON.stringify(value);
  return String(value);
}

/** 書いてある上書きを、画面の行にする。書いていない欄は「既定のまま」 */
export function toRows(overrides: Partial<Record<ParamKey, Permission>>): Rows {
  return Object.fromEntries(
    PARAM_KEYS.map((key): [ParamKey, Row] => {
      const permission = overrides[key];
      if (permission === undefined) {
        return [key, { mode: 'default', choices: undefined, fixedText: '' }];
      }
      return [
        key,
        {
          mode: permission.mode,
          choices: permission.mode === 'auto' ? permission.choices : undefined,
          fixedText: permission.mode === 'fixed' ? formatFixed(key, permission.value) : '',
        },
      ];
    }),
  ) as Rows;
}

function parseFixed(key: ParamKey, text: string): FormResult<unknown> {
  const label = PARAM_LABELS[key];
  let raw: unknown;
  switch (fixedValueKindOf(key)) {
    case 'text':
      raw = text;
      break;
    case 'number': {
      const trimmed = text.trim();
      raw = trimmed === '' ? Number.NaN : Number(trimmed);
      if (!Number.isFinite(raw)) return { ok: false, reason: `${label}: 数を入れる` };
      break;
    }
    case 'json':
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, reason: `${label}: JSON として読めない` };
      }
      break;
  }
  // 生成の要求と同じ検証を当てる: API は固定の値の形を見ないので、ここで通さないと生成のときに初めて落ちるため
  const parsed = generationRequestSchema.shape[key].safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? ` の ${issue.path.join('.')}` : '';
    return { ok: false, reason: `${label}${where}: ${issue?.message ?? '形が違う'}` };
  }
  return { ok: true, value: parsed.data };
}

/** 画面の行から、保存する上書きを組む。「既定のまま」の行は書かない */
export function buildOverrides(rows: Rows): FormResult<PermissionOverridesInput> {
  const overrides: Partial<Record<ParamKey, Permission>> = {};
  for (const key of PARAM_KEYS) {
    const row = rows[key];
    const label = PARAM_LABELS[key];
    switch (row.mode) {
      case 'default':
        continue;
      case 'off':
        if (isRequired(key)) {
          return { ok: false, reason: `${label}: 生成に欠かせないので「使わない」は選べない` };
        }
        overrides[key] = { mode: 'off' };
        break;
      case 'auto':
        if (row.choices !== undefined && row.choices.length === 0) {
          return {
            ok: false,
            reason: `${label}: 候補を1つ以上選ぶ（全部から選ばせるときは、絞り込みを外す）`,
          };
        }
        overrides[key] =
          row.choices === undefined ? { mode: 'auto' } : { mode: 'auto', choices: row.choices };
        break;
      case 'fixed': {
        const value = parseFixed(key, row.fixedText);
        if (!value.ok) return value;
        overrides[key] = { mode: 'fixed', value: value.value };
        break;
      }
    }
  }
  return { ok: true, value: overrides as PermissionOverridesInput };
}

/** いま効いている許可を言葉にする */
export function describePermission(permission: Permission): string {
  switch (permission.mode) {
    case 'auto':
      return permission.choices === undefined
        ? 'AI に任せる'
        : `AI に任せる（候補を ${permission.choices.length} 個に絞る）`;
    case 'fixed':
      return `固定: ${typeof permission.value === 'object' ? JSON.stringify(permission.value) : String(permission.value)}`;
    case 'off':
      return '使わない';
  }
}
