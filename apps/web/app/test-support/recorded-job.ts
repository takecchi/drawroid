// 実行器が実際に残した記録（fixtures/）を、swr の型へ当てて取り出す。作り方は fixtures/README.md。
import type {
  InterventionsResponse,
  IterationsResponse,
  JobDetail,
  LlmCallDetail,
  LlmCallsResponse,
  ReferencesResponse,
  SelectionsResponse,
} from '@drawroid/swr';

import interventionsJson from './fixtures/interventions.json';
import iterationsJson from './fixtures/iterations.json';
import jobJson from './fixtures/job.json';
import llmCallThinkJson from './fixtures/llm-call-think.json';
import llmCallsJson from './fixtures/llm-calls.json';
import referencesJson from './fixtures/references.json';
import selectionsJson from './fixtures/selections.json';

// JSON を import すると、リテラルの union（kind: 'auto' など）は string に広がり、型へ直には satisfies できない。
// そこで、文字列と真偽値を string・boolean に広げた型へ当てる: 欄の増減・名前・数と文字列の取り違え・null の有無のずれは typecheck で落ちる。
// union の取りうる値までは見ない（ここでは見られない）
type Loose<T> = T extends string
  ? string
  : T extends boolean
    ? boolean
    : T extends readonly (infer U)[]
      ? Loose<U>[]
      : T extends object
        ? { [K in keyof T]: Loose<T[K]> }
        : T;

export const recordedJob = jobJson satisfies Loose<JobDetail> as unknown as JobDetail;
export const recordedIterations =
  iterationsJson satisfies Loose<IterationsResponse> as unknown as IterationsResponse;
export const recordedLlmCalls =
  llmCallsJson satisfies Loose<LlmCallsResponse> as unknown as LlmCallsResponse;
export const recordedReferences =
  referencesJson satisfies Loose<ReferencesResponse> as unknown as ReferencesResponse;
export const recordedInterventions =
  interventionsJson satisfies Loose<InterventionsResponse> as unknown as InterventionsResponse;
export const recordedSelections =
  selectionsJson satisfies Loose<SelectionsResponse> as unknown as SelectionsResponse;
/** 考える役の1回目の呼び出し 1 本の中身 */
export const recordedThinkCall =
  llmCallThinkJson satisfies Loose<LlmCallDetail> as unknown as LlmCallDetail;
