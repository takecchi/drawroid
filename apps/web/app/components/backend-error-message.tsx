import { Disclosure, ErrorNote } from '@drawroid/ui';

import { describeBackendError } from '../lib/backend-error';
import { useBackendKind } from '../lib/use-backend-kind';

// 説明のあとに生の message を添える: message には繋ぎに行った URL が入っており、URL の打ち間違いを見つける手がかりになるため。
// 説明があるときは「詳しく」に畳む: 生の message にはサーバの言い方で同じ「すること」が入っていて、開いたままだと同じ文が2回並ぶため
export function BackendErrorMessage({ kind, message }: { kind: string; message: string }) {
  const description = describeBackendError(kind, useBackendKind());
  return (
    <ErrorNote className="space-y-1">
      {description === undefined ? (
        <p>
          <strong>失敗した（{kind}）</strong>
        </p>
      ) : (
        <>
          <p>
            <strong>{description.summary}</strong>
          </p>
          <p>{description.action}</p>
        </>
      )}
      {description === undefined ? (
        <p>
          <code>{message}</code>
        </p>
      ) : (
        <Disclosure summary="詳しく">
          <p>
            <code>{message}</code>
          </p>
        </Disclosure>
      )}
    </ErrorNote>
  );
}
