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
import {
  BulletList,
  CodeBlock,
  DescriptionList,
  Disclosure,
  ErrorNote,
  Section,
  SubSection,
} from '@drawroid/ui';
import { Link } from 'react-router';

import { formatTime, KIND_LABELS } from '../lib/job-labels';
import { InterventionList } from './intervention-view';
import { IterationList } from './iteration-view';
import { JobOperations } from './job-operations';
import { JobStatusBadge } from './job-status-badge';
import { LlmTotals } from './llm-call-view';
import { ReferenceList } from './reference-list';
import { StopReasonMessage } from './stop-reason-message';

function JobHeader({ job }: { job: JobDetailData }) {
  const { spec, state } = job;
  return (
    <Section>
      <h1 className="text-2xl font-semibold">
        <code>{spec.jobId}</code>
      </h1>
      <DescriptionList>
        <dt>種類</dt>
        <dd>{KIND_LABELS[spec.kind]}</dd>
        <dt>作成</dt>
        <dd>{formatTime(spec.createdAt)}</dd>
        <dt>状態</dt>
        <dd>
          <JobStatusBadge status={state.status} />
        </dd>
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
      </DescriptionList>
      {state.status === 'stopped' && <StopReasonMessage reason={state.reason} />}
    </Section>
  );
}

function JobRequest({ spec }: { spec: JobDetailData['spec'] }) {
  if (spec.kind === 'manual') {
    return (
      <Section title="依頼">
        <Disclosure summary="パラメータ">
          <CodeBlock>{JSON.stringify(spec.request, null, 2)}</CodeBlock>
        </Disclosure>
      </Section>
    );
  }
  const { stopConditions } = spec;
  return (
    <Section title="依頼">
      <p>{spec.request}</p>
      <SubSection title="止める条件">
        <BulletList>
          {stopConditions.aiJudgement && <li>AI が意図どおりと判断したら</li>}
          {stopConditions.maxIterations !== undefined && (
            <li>{stopConditions.maxIterations} 回まで</li>
          )}
          {stopConditions.maxDurationMs !== undefined && (
            <li>{stopConditions.maxDurationMs / 1000} 秒まで</li>
          )}
          {stopConditions.maxImages !== undefined && <li>{stopConditions.maxImages} 枚まで</li>}
        </BulletList>
      </SubSection>
      <p>1回に {spec.batchSize} 枚</p>
      <details>
        <summary>このジョブの予算</summary>
        {spec.budgets === undefined ? (
          <p>job.json に予算が無い（古いジョブ。既定の予算で回る）</p>
        ) : (
          <pre>{JSON.stringify(spec.budgets, null, 2)}</pre>
        )}
      </details>
    </Section>
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
    <Section title={title}>
      <ErrorNote>
        <BulletList>
          {items.map((item) => (
            <li key={item.label}>
              {item.label}: {item.reason}
            </li>
          ))}
        </BulletList>
      </ErrorNote>
    </Section>
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
      <ErrorNote>読めない: {error.message}</ErrorNote>
    );
  }
  return (
    <>
      <JobHeader job={data} />
      <JobRequest spec={data.spec} />
      <JobOperations job={data} />
      {selections.error !== undefined && (
        <ErrorNote>お気に入り・却下を読めない: {selections.error.message}</ErrorNote>
      )}
      {iterations.error !== undefined && (
        <ErrorNote>回を読めない: {iterations.error.message}</ErrorNote>
      )}
      {interventions.error !== undefined && (
        <ErrorNote>人間の指示を読めない: {interventions.error.message}</ErrorNote>
      )}
      {references.error !== undefined && (
        <ErrorNote>添えた参照画像を読めない: {references.error.message}</ErrorNote>
      )}
      {llmCalls.error !== undefined && (
        <ErrorNote>LLM の記録を読めない: {llmCalls.error.message}</ErrorNote>
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
            canPaintMask={data.spec.kind === 'auto' && live}
            {...(data.spec.kind === 'auto' && {
              adopt: live ? {} : { disabledReason: '描くのはもう止まっているので、決められない' },
            })}
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
