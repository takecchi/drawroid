import {
  isApiError,
  useInterventions,
  useIterations,
  useJob,
  useLlmCalls,
  useReferences,
  useSelections,
  type JobDetail as JobDetailData,
} from '@drawroid/swr';
import { Link } from 'react-router';

import { formatTime, KIND_LABELS, STATUS_LABELS } from '../lib/job-labels';
import { InterventionList } from './intervention-view';
import { IterationList } from './iteration-view';
import { JobOperations } from './job-operations';
import { LlmTotals } from './llm-call-view';
import { ReferenceList } from './reference-list';
import { StopReasonMessage } from './stop-reason-message';

function JobHeader({ job }: { job: JobDetailData }) {
  const { spec, state } = job;
  return (
    <section>
      <h1>
        <code>{spec.jobId}</code>
      </h1>
      <dl>
        <dt>種類</dt>
        <dd>{KIND_LABELS[spec.kind]}</dd>
        <dt>作成</dt>
        <dd>{formatTime(spec.createdAt)}</dd>
        <dt>状態</dt>
        <dd>{STATUS_LABELS[state.status]}</dd>
        {state.status !== 'queued' && state.startedAt !== undefined && (
          <>
            <dt>開始</dt>
            <dd>{formatTime(state.startedAt)}</dd>
          </>
        )}
        {state.status === 'stopped' && (
          <>
            <dt>停止</dt>
            <dd>{formatTime(state.stoppedAt)}</dd>
          </>
        )}
        {state.status !== 'queued' && (
          <>
            <dt>生成した枚数</dt>
            <dd>{state.imagesGenerated}</dd>
          </>
        )}
      </dl>
      {state.status === 'stopped' && <StopReasonMessage reason={state.reason} />}
    </section>
  );
}

function JobRequest({ spec }: { spec: JobDetailData['spec'] }) {
  if (spec.kind === 'manual') {
    return (
      <section>
        <h2>依頼</h2>
        <details>
          <summary>パラメータ</summary>
          <pre>{JSON.stringify(spec.request, null, 2)}</pre>
        </details>
      </section>
    );
  }
  const { stopConditions } = spec;
  return (
    <section>
      <h2>依頼</h2>
      <p>{spec.request}</p>
      <h3>止める条件</h3>
      <ul>
        {stopConditions.aiJudgement && <li>AI が意図どおりと判断したら</li>}
        {stopConditions.maxIterations !== undefined && (
          <li>{stopConditions.maxIterations} 回まで</li>
        )}
        {stopConditions.maxDurationMs !== undefined && (
          <li>{stopConditions.maxDurationMs / 1000} 秒まで</li>
        )}
        {stopConditions.maxImages !== undefined && <li>{stopConditions.maxImages} 枚まで</li>}
      </ul>
      <p>1回に {spec.batchSize} 枚</p>
    </section>
  );
}

function InvalidList({
  title,
  items,
}: {
  title: string;
  items: { label: string; reason: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <section role="alert">
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.label}>
            {item.label}: {item.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function JobDetail({ jobId }: { jobId: string }) {
  const { data, error } = useJob(jobId);
  // useJob の応答を待たずに取り始めない: 止まったかどうかが分かるまで、ポーリングするかを決められないため
  const live = data !== undefined && data.state.status !== 'stopped';
  const iterations = useIterations(data === undefined ? undefined : jobId, { live });
  // 手動ジョブには口出しが無く、取りに行くと 404 になる: 自動ジョブのときだけ取る
  const interventions = useInterventions(data?.spec.kind === 'auto' ? jobId : undefined, { live });
  const references = useReferences(data?.spec.kind === 'auto' ? jobId : undefined, { live });
  const llmCalls = useLlmCalls(data === undefined ? undefined : jobId, { live });
  const selections = useSelections(data === undefined ? undefined : jobId);
  // 外した選択（verdict が null）は入れない: 画像の側は「無い」を未選択として扱うため
  const verdicts = new Map(
    (selections.data?.selections ?? []).flatMap(({ imageKey, verdict }) =>
      verdict === null ? [] : [[imageKey, verdict] as const],
    ),
  );
  if (data === undefined) {
    if (error === undefined) return null;
    return isApiError(error) && error.status === 404 ? (
      <p>
        そのジョブは無い。<Link to="/jobs">ジョブ一覧へ</Link>
      </p>
    ) : (
      <p role="alert">読めない: {error.message}</p>
    );
  }
  return (
    <>
      <JobHeader job={data} />
      <JobRequest spec={data.spec} />
      <JobOperations job={data} />
      {selections.error !== undefined && (
        <p role="alert">お気に入り・却下を読めない: {selections.error.message}</p>
      )}
      {iterations.error !== undefined && (
        <p role="alert">回を読めない: {iterations.error.message}</p>
      )}
      {interventions.error !== undefined && (
        <p role="alert">人間の指示を読めない: {interventions.error.message}</p>
      )}
      {references.error !== undefined && (
        <p role="alert">添えた参照画像を読めない: {references.error.message}</p>
      )}
      {llmCalls.error !== undefined && (
        <p role="alert">LLM の記録を読めない: {llmCalls.error.message}</p>
      )}
      {interventions.data !== undefined && (
        <InterventionList interventions={interventions.data.interventions} />
      )}
      {references.data !== undefined && <ReferenceList references={references.data.references} />}
      {iterations.data !== undefined && (
        <>
          <IterationList
            jobId={jobId}
            heading={`回（${data.iterations.length}）`}
            iterations={iterations.data.iterations}
            calls={llmCalls.data?.calls ?? []}
            verdicts={verdicts}
            interventions={interventions.data?.interventions ?? []}
          />
          <InvalidList
            title="読めない回"
            items={iterations.data.invalid.map((i) => ({
              label: `${i.iteration} 回目`,
              reason: i.reason,
            }))}
          />
        </>
      )}
      {llmCalls.data !== undefined && (
        <>
          {llmCalls.data.total.calls > 0 && (
            <LlmTotals total={llmCalls.data.total} byIteration={llmCalls.data.byIteration} />
          )}
          <InvalidList
            title="読めない記録"
            items={llmCalls.data.invalid.map((i) => ({ label: i.callId, reason: i.reason }))}
          />
        </>
      )}
    </>
  );
}
