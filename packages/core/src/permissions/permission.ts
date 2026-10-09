import { z } from 'zod';

import type { BackendCapabilities } from '../backend.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';

export const permissionSchema = z.discriminatedUnion('mode', [
  // AI に任せる。choices があれば、その候補の中からだけ選ばせる
  z.object({ mode: z.literal('auto'), choices: z.array(z.string().min(1)).optional() }),
  // 人間が値を決め、AI は変えない
  z.object({ mode: z.literal('fixed'), value: z.unknown() }),
  z.object({ mode: z.literal('off') }),
]);
export type Permission = z.infer<typeof permissionSchema>;

export type Permissions = Record<ParamKey, Permission>;

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
  for (const key of PARAM_KEYS) {
    if (disabled[key] !== undefined) permissions[key] = { mode: 'off' };
  }
  return { permissions, disabled };
}
