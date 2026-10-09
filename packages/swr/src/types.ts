import type { BudgetOverrides, Permissions } from '@drawroid/core';
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
/** notes は候補の名前 → 説明。problem は、説明のファイルが読めなかったときの理由（そのとき notes は空） */
export type CandidateNotesResponse = InferResponseType<
  (typeof client.backend)['candidate-notes']['$get'],
  200
>;
/** 保存するときに送る、候補の名前 → 説明の全部 */
export type CandidateNotesInput = InferRequestType<
  (typeof client.backend)['candidate-notes']['$put']
>['json'];
/** 会話の一覧（最後の発言の先頭と、ターンが走っているか付き） */
export type ConversationsResponse = InferResponseType<typeof client.conversations.$get, 200>;
export type ConversationResponse = InferResponseType<typeof client.conversations.$post, 201>;
/** 確定したイベントの1ページ。last はどこまで読んだか、more はまだ後ろがあるか */
export type ConversationEventsResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['events']['$get'],
  200
>;
export type PostedMessageResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['messages']['$post'],
  202
>;
export type BackendSettingsResponse = InferResponseType<typeof client.settings.backend.$get, 200>;
export type MemoryList = InferResponseType<typeof client.memory.$get, 200>;
export type MemoryItemDetail = InferResponseType<(typeof client.memory)[':id']['$get'], 200>;
export type SaveMemoryInput = InferRequestType<(typeof client.memory)[':id']['$put']>['json'];
export type SavedMemoryItem = InferResponseType<(typeof client.memory)[':id']['$put'], 200>;
/** config が null なら、まだ設定されていない。apiKeyEnv は環境変数の名前と、入っているかだけ（値は返らない） */
export type LlmSettingsResponse = InferResponseType<typeof client.settings.llm.$get, 200>;
/** 保存するときに送る LLM の設定（既定値のある欄は省ける） */
export type LlmSettingsInput = InferRequestType<typeof client.settings.llm.$put>['json'];
/** overrides は書いた欄、permissions は土台に重ねた実際の許可 */
export type PermissionSettingsResponse = InferResponseType<
  typeof client.settings.permissions.$get,
  200
>;
/**
 * 保存するときに送る、全体の既定の許可の上書き（書いた欄だけ）。
 * core の型を使う: api の validator の schema は型を Permissions へ明示しているので、hono/client から引くと unknown になるため
 */
export type PermissionOverridesInput = Partial<Permissions>;
/** overrides は書いた欄、effective は既定に重ねた実際の値、defaults は何も書かないときの値 */
export type BudgetSettingsResponse = InferResponseType<typeof client.settings.budgets.$get, 200>;
/** 生成の進み具合の設定。includePreview が真なら、生成の途中の画像を流す（既定は流さない） */
export type GenerationProgressSettingsResponse = InferResponseType<
  (typeof client.settings)['generation-progress']['$get'],
  200
>;
/** 保存するときに送る、予算の上書き（書いた欄だけ）。api の schema は型を core へ明示しているので、core の型を使う */
export type BudgetOverridesInput = BudgetOverrides;
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
export type UnattachedLlmCallsResponse = InferResponseType<
  (typeof client)['llm-calls']['$get'],
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
export type AddMaskResponse = Extract<
  InferResponseType<(typeof client.jobs.auto)[':jobId']['interventions']['$post'], 202>,
  { mask: unknown }
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
/** 設定の画面の「確かめる」の結果。項目ごとに ok（よい）か、足りないなら todo（何をすればよいか） */
export type DoctorResponse = InferResponseType<typeof client.doctor.$post, 200>;
/** 会話へ送り込んだ画像の ID */
export type ConversationUploadResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['uploads']['$post'],
  201
>;
export type AdoptImageResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['adopt']['$post'],
  200
>;
