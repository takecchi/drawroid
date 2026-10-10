import { describeInputOverflow, findInputOverflows, type Budgets } from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

import type { ApiDeps } from './deps.js';

/**
 * 予算の欄ごとの上限の和が、分かっている役の窓を超えるなら、保存を断る理由を返す。超えなければ undefined。
 * 窓を返す口が無ければ比べない。llm を渡せばその設定の窓で、省けばいま効いている設定の窓で比べる
 */
export async function windowProblem(
  deps: Pick<ApiDeps, 'inputWindows'>,
  budgets: Budgets,
  llm?: LlmConfig,
): Promise<string | undefined> {
  if (deps.inputWindows === undefined) return undefined;
  const overflows = findInputOverflows(budgets, await deps.inputWindows(llm));
  if (overflows.length === 0) return undefined;
  return `${overflows.map(describeInputOverflow).join('。')}。予算の欄を小さくするか、LLM の設定でその役の文脈の上限を大きくする`;
}
