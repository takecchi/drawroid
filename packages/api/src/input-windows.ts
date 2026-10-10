import { describeInputOverflow, findInputOverflows, type Budgets } from '@drawroid/core';
import type { LlmConfig } from '@drawroid/llm';

import type { ApiDeps } from './deps.js';

const lines = new WeakMap<object, Promise<unknown>>();

/**
 * 窓と比べてから書くまでを、予算の保存と LLM の設定の保存とで1本の列に並べる。
 */
// 並べる: 同時に来ると、どちらも相手の保存の前の値（古い窓・古い予算）と比べて通り、窓に入らない組み合わせが残るため
export function inWindowCheckLine<T>(deps: object, run: () => Promise<T>): Promise<T> {
  const before = lines.get(deps) ?? Promise.resolve();
  const result = before.then(run, run);
  lines.set(
    deps,
    result.catch(() => undefined),
  );
  return result;
}

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
