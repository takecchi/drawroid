import { useJob } from '@drawroid/swr';

import { BackendErrorMessage } from './backend-error-message';

export function JobDetail({ jobId }: { jobId: string | undefined }) {
  const { data, error } = useJob(jobId);
  return (
    <section>
      <h2>選んだジョブ</h2>
      {jobId === undefined && <p>ジョブを選ぶと、ここに結果が出る。</p>}
      {error !== undefined && <p role="alert">読めない: {error.message}</p>}
      {data !== undefined && (
        <>
          <p>
            <code>{data.spec.jobId}</code> 状態: {data.state.status}
          </p>
          {data.state.status === 'stopped' && data.state.reason.kind === 'error' && (
            <BackendErrorMessage
              kind={data.state.reason.backendErrorKind ?? 'unknown'}
              message={data.state.reason.detail}
            />
          )}
          {data.iterations.map((iteration) => (
            <div key={iteration.iteration}>
              <h3>{iteration.iteration} 回目</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {iteration.images.map((image) => (
                  <figure key={image.index} style={{ margin: 0 }}>
                    <img src={image.url} alt={`seed ${image.seed}`} style={{ maxWidth: 320 }} />
                    <figcaption>seed {image.seed ?? '不明'}</figcaption>
                  </figure>
                ))}
              </div>
              <details>
                <summary>request</summary>
                <pre>{JSON.stringify(iteration.request, null, 2)}</pre>
              </details>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
