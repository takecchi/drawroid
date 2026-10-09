import { isApiError, useJob, type JobDetail as JobDetailData } from '@drawroid/swr';
import { Link } from 'react-router';

import { formatTime, KIND_LABELS, STATUS_LABELS } from '../lib/job-labels';
import { IterationList } from './iteration-view';
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

export function JobDetail({ jobId }: { jobId: string }) {
  const { data, error } = useJob(jobId);
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
      <IterationList iterations={data.iterations} />
    </>
  );
}
