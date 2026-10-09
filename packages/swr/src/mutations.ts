import type {
  GenerationRequestInput,
  SelectionVerdict,
  StopConditions,
  StopConditionsChange,
} from '@drawroid/core';
import { mutate } from 'swr';

import { unwrap } from './api-error.js';
import { client } from './client.js';
import { keys } from './keys.js';
import type {
  AddInstructionResponse,
  BackendSettingsResponse,
  ChangeStopConditionsResponse,
  CreateAutoJobResponse,
  SetSelectionResponse,
  StopConditionsDraftResponse,
} from './types.js';

/** 検証に落ちたときは ApiError（kind: 'invalid_request'）を投げる */
export async function startManualJob(params: GenerationRequestInput): Promise<{ jobId: string }> {
  const started = await unwrap<{ jobId: string }>(() => client.jobs.manual.$post({ json: params }));
  await mutate(keys.jobs);
  return started;
}

/** URL が不正なときは ApiError（kind: 'invalid_request'）を投げる */
export async function saveBackendSettings(input: {
  forgeUrl: string;
}): Promise<BackendSettingsResponse> {
  const saved = await unwrap<BackendSettingsResponse>(() =>
    client.settings.backend.$put({ json: input }),
  );
  // 状態と候補は、繋ぎ直した先のものへ取り直す: 古い Forge の応答が残ると、直したのに直っていないように見えるため
  await mutate((key) => typeof key === 'string' && key.startsWith(keys.backend));
  await mutate(keys.backendSettings, saved, { revalidate: false });
  return saved;
}

/** 案を返すだけで何も保存しない。LLM 未設定は ApiError（kind: 'llm_not_configured'）、変換失敗は 'unparsable' */
export async function parseStopConditionsText(text: string): Promise<StopConditionsDraftResponse> {
  return unwrap<StopConditionsDraftResponse>(() =>
    client['stop-conditions'].parse.$post({ json: { text } }),
  );
}

/** 検証に落ちたとき（止まらない条件など）は ApiError（kind: 'invalid_request'）を投げる */
export async function createAutoJob(input: {
  request: string;
  stopConditions: StopConditions;
  batchSize: number;
}): Promise<CreateAutoJobResponse> {
  const created = await unwrap<CreateAutoJobResponse>(() =>
    client.jobs.auto.$post({ json: input }),
  );
  await mutate(keys.jobs);
  return created;
}

export async function stopJob(jobId: string): Promise<void> {
  await unwrap<unknown>(() => client.jobs.auto[':jobId'].stop.$post({ param: { jobId } }));
  await refreshJob(jobId);
}

/** 止まったジョブへは ApiError（status 409）、空の指示は 'invalid_request' を投げる */
export async function addInstruction(jobId: string, text: string): Promise<AddInstructionResponse> {
  const added = await unwrap<AddInstructionResponse>(() =>
    client.jobs.auto[':jobId'].interventions.$post(
      { param: { jobId } },
      jsonBody({ kind: 'instruction', text }),
    ),
  );
  await refreshJob(jobId);
  return added;
}

/** 重ねたあとの実際の止める条件を返す。止まったジョブへは ApiError（status 409）を投げる */
export async function changeStopConditions(
  jobId: string,
  change: StopConditionsChange,
): Promise<ChangeStopConditionsResponse> {
  const changed = await unwrap<ChangeStopConditionsResponse>(() =>
    client.jobs.auto[':jobId'].interventions.$post(
      { param: { jobId } },
      jsonBody({ kind: 'stopConditions', stopConditions: change }),
    ),
  );
  await refreshJob(jobId);
  return changed;
}

/** verdict が null のときは選択を外す */
export async function setSelection(
  jobId: string,
  imageKey: string,
  verdict: SelectionVerdict | null,
): Promise<SetSelectionResponse> {
  const set = await unwrap<SetSelectionResponse>(() =>
    client.jobs[':jobId'].selections[':imageKey'].$put(
      { param: { jobId, imageKey } },
      jsonBody({ verdict }),
    ),
  );
  await mutate(keys.selections(jobId));
  return set;
}

// 一覧も取り直す: 止めた・口出しした直後に、一覧の状態が古いまま残らないようにするため
async function refreshJob(jobId: string): Promise<void> {
  await Promise.all([mutate(keys.job(jobId)), mutate(keys.jobs)]);
}

// json: で渡さない: この3つの経路は body を hono の validator ではなく zod の safeParse で検証しており、クライアントの型に body が現れないため
function jsonBody(body: unknown) {
  return {
    init: { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  };
}
