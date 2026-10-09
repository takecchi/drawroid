import type { LlmRole } from '@drawroid/core';

import type { LlmConfig } from './config.js';

const ROLE_LABELS: Record<LlmRole, string> = { think: '考える役', judge: '見る役' };

export type OutputLimitWarning = {
  role: LlmRole;
  /** 上げるべき設定がある llm.roles の鍵。見る役を省いた設定では think */
  configKey: LlmRole;
  maxOutputTokens: number;
  estimatedOutputTokens: number;
  message: string;
};

/**
 * 出力の上限が出力の見積もりより小さい役を挙げる。値は書き換えない: 利用者が決めた値で、
 * モデルによっては小さい出力で足りることもあるため、気づけるようにするだけにする。
 */
export function outputLimitWarnings(
  config: LlmConfig,
  estimates: Record<LlmRole, number>,
): OutputLimitWarning[] {
  const warnings: OutputLimitWarning[] = [];
  for (const role of ['think', 'judge'] as const) {
    const configKey = role === 'judge' && config.roles.judge === undefined ? 'think' : role;
    const maxOutputTokens = config.roles[configKey]?.maxOutputTokens;
    const estimated = estimates[role];
    if (maxOutputTokens === undefined || maxOutputTokens >= estimated) continue;
    const suggested = Math.max(2048, 2 ** Math.ceil(Math.log2(estimated * 1.5)));
    const inherited = configKey === role ? '' : `（見る役は${ROLE_LABELS[configKey]}の設定を使う）`;
    warnings.push({
      role,
      configKey,
      maxOutputTokens,
      estimatedOutputTokens: estimated,
      message:
        `${ROLE_LABELS[role]}の出力の上限（llm.roles.${configKey}.maxOutputTokens = ${maxOutputTokens}）${inherited}は、` +
        `出力の見積もり（約 ${estimated} トークン）より小さく、出力が切れて止まる見込みがある。` +
        `${ROLE_LABELS[configKey]}の「出力の上限（トークン）」を ${suggested} 以上に上げる（値は自動では書き換えない）。`,
    });
  }
  return warnings;
}
