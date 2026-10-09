import { BulletList, Muted, Section } from '@drawroid/ui';
import { useBackendStatus } from '@drawroid/swr';

import { BackendErrorMessage } from './backend-error-message';

export function BackendStatus() {
  const { data, error, isLoading } = useBackendStatus();
  return (
    <Section title="バックエンドの状態">
      {error !== undefined ? (
        <BackendErrorMessage kind={error.kind} message={error.message} />
      ) : isLoading || data === undefined ? (
        <Muted>確認しています。</Muted>
      ) : (
        <>
          <p className="text-sm">繋がっている。</p>
          {data.capabilities.unavailable.length > 0 && (
            <>
              <p className="text-sm">使えない機能</p>
              <BulletList>
                {data.capabilities.unavailable.map(({ feature, reason }) => (
                  <li key={feature}>
                    {feature}: {reason}
                  </li>
                ))}
              </BulletList>
            </>
          )}
        </>
      )}
    </Section>
  );
}
