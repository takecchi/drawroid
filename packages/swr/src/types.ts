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
// 送る側の形は body の入力型から導く: api の references.ts の transform は出力を Uint8Array にするが、client の json に要るのは入力（base64）の型のため
export type ReferenceUpload = Extract<
  InferRequestType<(typeof client.jobs.auto)[':jobId']['interventions']['$post']>['json'],
  { kind: 'reference' }
>['image'];
export type SetSelectionResponse = InferResponseType<
  (typeof client.jobs)[':jobId']['selections'][':imageKey']['$put'],
  200
>;
