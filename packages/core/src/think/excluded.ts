import { z } from 'zod';

import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import type { DisabledReason, Permissions } from '../permissions/permission.js';
import type { OmittedReason } from './params-schema.js';

export type ExcludedReason = DisabledReason | { kind: OmittedReason };

export type ExcludedParam = {
  param: ParamKey;
  /** 人間が決めた許可 */
  wanted: 'auto' | 'fixed';
  reason: ExcludedReason;
};

export const iterationPlanSchema = z.object({
  excluded: z.array(
    z.object({
      param: z.enum(PARAM_KEYS),
      wanted: z.enum(['auto', 'fixed']),
      reason: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('backend'), detail: z.string() }),
        z.object({ kind: z.literal('no-mask') }),
        z.object({ kind: z.literal('no-candidates-shown') }),
        z.object({ kind: z.literal('not-supported-yet') }),
      ]),
    }),
  ),
});

// 人間が「使わない」にしたものは載せない: 外したのは人間で、AI の選択肢から外れた理由の記録ではないため
export function excludedOf(
  merged: Permissions,
  disabled: Partial<Record<ParamKey, DisabledReason>>,
  omitted: Partial<Record<ParamKey, OmittedReason>>,
): ExcludedParam[] {
  const excluded: ExcludedParam[] = [];
  for (const param of PARAM_KEYS) {
    const mode = merged[param].mode;
    if (mode === 'off') continue;
    const disabledReason = disabled[param];
    const omittedReason = omitted[param];
    if (disabledReason !== undefined) {
      excluded.push({ param, wanted: mode, reason: disabledReason });
    } else if (omittedReason !== undefined) {
      excluded.push({ param, wanted: 'auto', reason: { kind: omittedReason } });
    }
  }
  return excluded;
}
