import type { ReferencesResponse } from '@drawroid/swr';
import { AuthorMark, Disclosure, EmptyState, Section } from '@drawroid/ui';

import { formatTime } from '../lib/job-labels';

export type Reference = ReferencesResponse['references'][number];

export function ReferenceItem({ reference }: { reference: Reference }) {
  return (
    <AuthorMark author="human" label="人間が添えた参照画像" meta={formatTime(reference.receivedAt)}>
      <div>
        <img
          src={reference.previewUrl}
          alt={reference.note ?? `参照画像 ${reference.refId}`}
          className="max-w-40 rounded-md"
        />
      </div>
      {reference.note !== undefined && <p>{reference.note}</p>}
      <p>
        {reference.gist === undefined
          ? '次の回の境目で、見る役が1度だけ見て要点にする'
          : `要点: ${reference.gist}`}
      </p>
      {reference.sentInCall !== undefined && (
        // 外さずに畳む: 参照画像を見る役に渡したのが1度だけかを、画面から確かめられるようにするため（M3:103）。
        // ID は作り手が確かめるためのもので、人が読む欄に並べると目障りになる
        <Disclosure summary="詳しく">
          <p className="text-xs">
            見る役に渡した呼び出し: <code>{reference.sentInCall}</code>
          </p>
        </Disclosure>
      )}
    </AuthorMark>
  );
}

// 受けた順に並べ直さない: ストアが受けた順で返す約束で、ここで時刻の文字列を比べ直すと形式の違いで崩れるため
export function ReferenceList({ references }: { references: Reference[] }) {
  return (
    <Section title={`人間が添えた参照画像（${references.length}）`}>
      {references.length === 0 && <EmptyState title="まだ参照画像は無い。" />}
      {references.map((reference) => (
        <ReferenceItem key={reference.refId} reference={reference} />
      ))}
    </Section>
  );
}
