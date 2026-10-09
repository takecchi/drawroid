import type { ReferenceUploadInput } from '@drawroid/api';
import type { InferRequestType, InferResponseType } from 'hono/client';

import type { client } from './client.js';

export type BackendStatus = InferResponseType<typeof client.backend.$get, 200>;
export type CandidatesResponse = InferResponseType<
  (typeof client.backend.candidates)[':kind']['$get'],
  200
>;
export type JobsResponse = InferResponseType<typeof client.jobs.$get, 200>;
export type JobDetail = InferResponseType<(typeof client.jobs)[':jobId']['$get'], 200>;
export type BackendSettingsResponse = InferResponseType<typeof client.settings.backend.$get, 200>;
export type MemoryList = InferResponseType<typeof client.memory.$get, 200>;
export type MemoryItemDetail = InferResponseType<(typeof client.memory)[':id']['$get'], 200>;
export type SaveMemoryInput = InferRequestType<(typeof client.memory)[':id']['$put']>['json'];
export type SavedMemoryItem = InferResponseType<(typeof client.memory)[':id']['$put'], 200>;
/** config が null なら、まだ設定されていない。apiKeyEnv は環境変数の名前と、入っているかだけ（値は返らない） */
export type LlmSettingsResponse = InferResponseType<typeof client.settings.llm.$get, 200>;
/** 保存するときに送る LLM の設定（既定値のある欄は省ける） */
export type LlmSettingsInput = InferRequestType<typeof client.settings.llm.$put>['json'];
export type IterationsResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['iterations']['$get'],
  200
>;
export type LlmCallsResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['llm-calls']['$get'],
  200
>;
export type LlmCallDetail = InferResponseType<
  (typeof client.jobs)[':jobId']['llm-calls'][':callId']['$get'],
  200
>;
export type SelectionsResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['selections']['$get'],
  200
>;
export type InterventionsResponse = InferResponseType<
  (typeof client.jobs.auto)[':jobId']['interventions']['$get'],
  200
>;
export type StopConditionsDraftResponse = InferResponseType<
  (typeof client)['stop-conditions']['parse']['$post'],
  200
>;
export type CreateAutoJobResponse = InferResponseType<typeof client.jobs.auto.$post, 202>;
export type AddInstructionResponse = Extract<
  InferResponseType<(typeof client.jobs.auto)[':jobId']['interventions']['$post'], 202>,
  { intervention: unknown }
>;
export type ChangeStopConditionsResponse = Extract<
  InferResponseType<(typeof client.jobs.auto)[':jobId']['interventions']['$post'], 202>,
  { stopConditions: unknown }
>;
export type StopConditionsResponse = InferResponseType<
  (typeof client.jobs.auto)[':jobId']['stop-conditions']['$get'],
  200
>;
export type AddReferenceResponse = Extract<
  InferResponseType<(typeof client.jobs.auto)[':jobId']['interventions']['$post'], 202>,
  { reference: unknown }
>;
/** 参照画像1枚を送るときの形。data は base64 の文字列（api の validator の変換の前の形） */
export type ReferenceUpload = ReferenceUploadInput;
export type ReferencesResponse = InferResponseType<
  (typeof client.jobs.auto)[':jobId']['references']['$get'],
  200
>;
export type SetSelectionResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['selections'][':imageKey']['$put'],
  200
>;
