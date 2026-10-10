import {
  COMPARED_ROLES,
  describeInputOverflow,
  findInputOverflows,
  type Budgets,
} from '@drawroid/core';
import { ROLE_LABELS, type LlmConfig } from '@drawroid/llm';

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
  return (await checkWindows(deps, budgets, llm)).problem;
}

/**
 * windowProblem に加えて、窓が分からず比べられなかった役があれば、そのことを1文で返す（notCompared）。
 * 窓を返す口が無いときは、比べる必要が無いので何も返さない
 */
// 窓を返さなかった役を「分からなかった役」とみなす: 窓の口は、分かっている窓だけを返す約束のため。口の戻りを広げずに済む
export async function checkWindows(
  deps: Pick<ApiDeps, 'inputWindows'>,
  budgets: Budgets,
  llm?: LlmConfig,
): Promise<{ problem?: string; notCompared?: string }> {
  if (deps.inputWindows === undefined) return {};
  const windows = await deps.inputWindows(llm);
  const overflows = findInputOverflows(budgets, windows);
  if (overflows.length > 0) {
    return {
      problem: `${overflows.map(describeInputOverflow).join('。')}。予算の欄を小さくするか、LLM の設定でその役の文脈の上限を大きくする`,
    };
  }
  const unknown = COMPARED_ROLES.filter((role) => windows[role] === undefined);
  if (unknown.length === 0) return {};
  return {
    notCompared: `窓と比べなかった。理由: ${unknown.map((role) => ROLE_LABELS[role]).join('・')}の文脈の上限が分からない（contextTokens を書いておらず、LLM からも読めなかった）`,
  };
}
