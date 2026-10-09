import { z } from 'zod';

import { BACKEND_FEATURES, type BackendCapabilities } from '../backend.js';
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

function schemaFor(key: ParamKey) {
  return isRequiredParamKey(key) ? requiredPermissionSchema : permissionSchema;
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
