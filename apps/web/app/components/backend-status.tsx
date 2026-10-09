import { useBackendStatus } from '@drawroid/swr';

import { BackendErrorMessage } from './backend-error-message';

export function BackendStatus() {
  const { data, error, isLoading } = useBackendStatus();
  return (
    <section>
      <h2>バックエンドの状態</h2>
      {error !== undefined ? (
        <BackendErrorMessage kind={error.kind} message={error.message} />
      ) : isLoading || data === undefined ? (
        <p>確認しています。</p>
      ) : (
        <>
          <p>繋がっている。</p>
          {data.capabilities.unavailable.length > 0 && (
            <>
              <p>使えない機能</p>
              <ul>
                {data.capabilities.unavailable.map(({ feature, reason }) => (
                  <li key={feature}>
                    {feature}: {reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
