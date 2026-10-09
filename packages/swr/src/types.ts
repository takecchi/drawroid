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
