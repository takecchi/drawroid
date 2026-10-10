import { z } from 'zod';

import { BACKEND_FEATURES, generationRequestSchema, type BackendCapabilities } from '../backend.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';

// AI に任せる。choices があれば、その候補の中からだけ選ばせる
const autoSchema = z.object({
  mode: z.literal('auto'),
  choices: z.array(z.string().min(1)).optional(),
});
// 人間が値を決め、AI は変えない
const fixedSchema = z.object({ mode: z.literal('fixed'), value: z.unknown() });
const offSchema = z.object({ mode: z.literal('off') });

export const permissionSchema = z.discriminatedUnion('mode', [autoSchema, fixedSchema, offSchema]);
export type Permission = z.infer<typeof permissionSchema>;

/** 生成に欠かせない欄。許可は「AI に任せる」か「固定」だけで、「使わない」は選べない */
// 「使わない」を許して既定値で埋める形にしない: 既定値をどこから取るかという仕組みを新しく足すことになるため
export const REQUIRED_PARAM_KEYS = [
  'prompt',
  'steps',
  'cfgScale',
  'width',
  'height',
] as const satisfies readonly ParamKey[];
export type RequiredParamKey = (typeof REQUIRED_PARAM_KEYS)[number];

export const requiredPermissionSchema = z.discriminatedUnion('mode', [autoSchema, fixedSchema]);
export type RequiredPermission = z.infer<typeof requiredPermissionSchema>;

export type Permissions = {
  [K in ParamKey]: K extends RequiredParamKey ? RequiredPermission : Permission;
};

function isRequiredParamKey(key: ParamKey): key is RequiredParamKey {
  return (REQUIRED_PARAM_KEYS as readonly ParamKey[]).includes(key);
}

/**
 * そのパラメータの固定の値。生成の要求の該当する欄と同じ形であること。
 */
// 固定の値を要求の欄で検証する: 形の違う値を受けると、保存も投入も通ってから、生成の直前に初めて落ちるため
function fixedSchemaFor(key: ParamKey) {
  const field = generationRequestSchema.shape[key];
  return z.object({
    mode: z.literal('fixed'),
    // any から始める: unknown から pipe すると、欄ごとに違う schema の和を型の上で渡せないため（検証の中身は欄の schema のまま）。
    // value の鍵そのものは省けないので、値の無い固定は欄が省ける欄でも通らない
    value: z.any().pipe(field),
  });
}

function schemaFor(key: ParamKey) {
  const fixed = fixedSchemaFor(key);
  return isRequiredParamKey(key)
    ? z.discriminatedUnion('mode', [autoSchema, fixed])
    : z.discriminatedUnion('mode', [autoSchema, fixed, offSchema]);
}

// 欄の集まりを PARAM_KEYS から作るので zod が型を推論できず、型は Permissions として宣言する
/** 全体の既定の許可。全パラメータぶんの欄がそろっていること */
export const permissionsSchema = z.object(
  Object.fromEntries(PARAM_KEYS.map((key) => [key, schemaFor(key)])),
) as unknown as z.ZodType<Permissions>;

/** ジョブごとの上書き。書いた欄だけを検証する */
export const permissionOverridesSchema = z
  .object(Object.fromEntries(PARAM_KEYS.map((key) => [key, schemaFor(key).optional()])))
  .strict() as unknown as z.ZodType<Partial<Permissions>>;

const EXPECTED_TYPE_LABELS: Record<string, string> = {
  object: 'オブジェクト',
  array: '配列',
  string: '文字列',
  number: '数',
  int: '整数',
  boolean: '真偽値',
};

/**
 * 許可の検証が落ちた理由を、短い日本語の文にする。どの欄の誤りかは、呼ぶ側が前に付ける。
 */
// zod の message をそのまま返さない: 英語の文が話す役や画面に渡り、何を直せばよいかが伝わらないため（「許可: Unrecognized keys」の実例）
export function describePermissionIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'unrecognized_keys':
      return `知らない欄（${issue.keys.join('・')}）`;
    case 'invalid_union': {
      if (issue.discriminator !== 'mode') return '形が違う';
      // options は実行時には入るが、zod の型には無い
      const modes = ((issue as { options?: readonly unknown[] }).options ?? []).map(String);
      if (modes.length === 0) return '形が違う';
      // 「mode は」と欄の名前を書かない: 判別の誤りの道は mode で終わり、呼ぶ側が前に付けるので「mode: mode は」と二度出るため
      return `${modes.join('・')} のどれかで書く${modes.includes('off') ? '' : '（この欄は off にできない）'}`;
    }
    case 'invalid_type': {
      const expected = EXPECTED_TYPE_LABELS[issue.expected];
      return expected === undefined ? '形が違う' : `形が違う（${expected}で書く）`;
    }
    // 境目を含まない範囲を「以上」「以下」と書かない: 境目の値なら通るように読めるため
    case 'too_small':
      return `小さすぎる（${String(issue.minimum)} ${issue.inclusive === false ? 'より大きく' : '以上'}）`;
    case 'too_big':
      return `大きすぎる（${String(issue.maximum)} ${issue.inclusive === false ? 'より小さく' : '以下'}）`;
    default:
      return '形が違う';
  }
}

/** 読めなかった上書きの行。param が '*' なら、上書き全体が読めなかった */
export interface InvalidPermission {
  param: string;
  reason: string;
}

/**
 * 書かれた上書き（config.json の permissions）を、行ごとに読む。読めない行は外し、理由を invalid に返す。
 * 外した行は上書きが無いのと同じなので、土台（既定）に戻る。
 */
// 1行の誤りで全体を捨てない: 人間が書き損じた1行のために、起動も画面も止まり、ほかの許可まで効かなくなるため
export function readPermissionOverrides(raw: unknown): {
  overrides: Partial<Permissions>;
  invalid: InvalidPermission[];
} {
  if (raw === undefined) return { overrides: {}, invalid: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      overrides: {},
      invalid: [{ param: '*', reason: '許可が、パラメータごとの欄の集まりになっていない' }],
    };
  }
  const overrides: Record<string, unknown> = {};
  const invalid: InvalidPermission[] = [];
  for (const [param, value] of Object.entries(raw)) {
    if (!(PARAM_KEYS as readonly string[]).includes(param)) {
      invalid.push({ param, reason: '知らないパラメータ' });
      continue;
    }
    const parsed = schemaFor(param as ParamKey).safeParse(value);
    if (parsed.success) {
      overrides[param] = parsed.data;
      continue;
    }
    const reason = parsed.error.issues
      .map(
        (issue) =>
          `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${describePermissionIssue(issue)}`,
      )
      .join(' / ');
    invalid.push({ param, reason });
  }
  return { overrides: overrides as Partial<Permissions>, invalid };
}

export type DisabledReason = { kind: 'backend'; detail: string } | { kind: 'no-mask' };

export interface IterationConditions {
  capabilities: BackendCapabilities;
  hasMask: boolean;
}

export interface EffectivePermissions {
  permissions: Permissions;
  disabled: Partial<Record<ParamKey, DisabledReason>>;
}

export function mergePermissions(
  defaults: Permissions,
  jobOverride: Partial<Permissions>,
): Permissions {
  return { ...defaults, ...jobOverride };
}

// 使えないものを「使わない」と同じ形に落とす: 後段（出力スキーマ・固定の適用）に別の分岐を持たせないため
export function effectivePermissions(
  jobPermissions: Permissions,
  conditions: IterationConditions,
): EffectivePermissions {
  const disabled: Partial<Record<ParamKey, DisabledReason>> = {};
  for (const { feature, reason } of conditions.capabilities.unavailable) {
    disabled[feature] = { kind: 'backend', detail: reason };
  }
  if (!conditions.hasMask && disabled.inpaint === undefined) {
    disabled.inpaint = { kind: 'no-mask' };
  }
  const permissions = { ...jobPermissions };
  for (const feature of BACKEND_FEATURES) {
    if (disabled[feature] !== undefined) permissions[feature] = { mode: 'off' };
  }
  return { permissions, disabled };
}
