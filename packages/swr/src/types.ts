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
// client の json は validator の transform 後の型（data が Uint8Array）で推論されるが、線の上を流れるのは入力の base64 文字列。api は入力側の型を出していないため、data だけを置き換える
type ReferenceBody = Extract<
  InferRequestType<(typeof client.jobs.auto)[':jobId']['interventions']['$post']>['json'],
  { kind: 'reference' }
>['image'];
export type ReferenceUpload = Omit<ReferenceBody, 'data'> & { data: string };
/** 線の上では base64 のまま流れる。client の型が transform 後の形を要求するので、ここだけで合わせる */
export type ReferenceWireBody = ReferenceBody;
export type SetSelectionResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['selections'][':imageKey']['$put'],
  200
>;
