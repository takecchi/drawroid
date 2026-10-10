import { DEFAULT_MODEL_WINDOW, type LlmRole, type ModelWindow } from '@drawroid/core';
import { resolveRoles, ROLE_LABELS, type LlmConfig } from '@drawroid/llm';

// 予算と比べる役: ジョブのループで入力を組む役だけ（話す役は別の予算を持つ）
const COMPARED_ROLES = ['think', 'judge'] as const;

/**
 * 予算と比べる、役ごとの窓を返す口。llm を渡せばその設定の、省けばいま効いている設定（provider から読んだ窓を含む）の、
 * 分かっている窓だけを返す。分からない役があれば、比べなかったことを1行出す
 */
// 分からない役を既定の窓で比べない: 実際の窓は LLM 側で決まり、既定の窓で断ると、収まる設定まで保存できなくなるため
export function createInputWindows(deps: {
  current: () => LlmConfig | undefined;
  log: (line: string) => void;
}): (llm?: LlmConfig) => Promise<Partial<Record<LlmRole, ModelWindow>>> {
  return async (llm) => {
    const config = llm ?? deps.current();
    if (config === undefined) {
      deps.log('drawroid: LLM が未設定なので、予算の欄ごとの上限の和を窓と比べなかった');
      return {};
    }
    const roles = resolveRoles(config);
    const windows: Partial<Record<LlmRole, ModelWindow>> = {};
    const unknown: LlmRole[] = [];
    for (const role of COMPARED_ROLES) {
      const { contextTokens, maxOutputTokens } = roles[role];
      if (contextTokens === undefined) {
        unknown.push(role);
        continue;
      }
      windows[role] = {
        contextTokens,
        maxOutputTokens: maxOutputTokens ?? DEFAULT_MODEL_WINDOW.maxOutputTokens,
      };
    }
    if (unknown.length > 0) {
      deps.log(
        `drawroid: ${unknown.map((role) => ROLE_LABELS[role]).join('・')}の文脈の上限が分からないので、予算の欄ごとの上限の和と比べなかった`,
      );
    }
    return windows;
  };
}
