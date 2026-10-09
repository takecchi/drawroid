import type { MemoryRoleLimits } from './select.js';

/** 役ごとに、1回の呼び出しに載せる記憶の件数と文字数（maxSize は本文の文字数） */
export type MemoryLimits = { think: MemoryRoleLimits; judge: MemoryRoleLimits };

// 値は仮置き。設定（config.json の budgets）の既定値として、実測で見直す
export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  think: { maxCount: 8, maxSize: 400, always: { maxCount: 5, maxSize: 200 } },
  judge: { maxCount: 5, maxSize: 240, always: { maxCount: 4, maxSize: 160 } },
};
