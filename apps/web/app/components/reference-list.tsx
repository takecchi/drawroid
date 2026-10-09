import type { ReferencesResponse } from '@drawroid/swr';

import { formatTime } from '../lib/job-labels';
import { AuthorLabel, markStyle } from './intervention-view';

export type Reference = ReferencesResponse['references'][number];

export function ReferenceItem({ reference }: { reference: Reference }) {
  return (
    <div style={markStyle('human')}>
      <AuthorLabel author="human">人間が添えた参照画像</AuthorLabel>{' '}
      {formatTime(reference.receivedAt)}
      <div style={{ margin: '4px 0' }}>
        <img
          src={reference.previewUrl}
          alt={reference.note ?? `参照画像 ${reference.refId}`}
          style={{ maxWidth: 160 }}
        />
      </div>
      {reference.note !== undefined && <p style={{ margin: '4px 0' }}>{reference.note}</p>}
      <p style={{ margin: '4px 0' }}>
        {reference.gist === undefined
          ? '次の回の境目で、見る役が1度だけ見て要点にする'
          : `要点: ${reference.gist}`}
      </p>
      {reference.sentInCall !== undefined && (
        // 渡した呼び出しを出す: 参照画像を見る役に渡したのが1度だけかを、画面から確かめられるようにするため（M3:103）
        <p style={{ margin: '4px 0', fontSize: '0.85em' }}>
          見る役に渡した呼び出し: {reference.sentInCall}
        </p>
      )}
    </div>
  );
}

// 受けた順に並べ直さない: ストアが受けた順で返す約束で、ここで時刻の文字列を比べ直すと形式の違いで崩れるため
export function ReferenceList({ references }: { references: Reference[] }) {
  return (
    <section>
      <h2>人間が添えた参照画像（{references.length}）</h2>
      {references.length === 0 && <p>まだ参照画像は無い。</p>}
      {references.map((reference) => (
        <ReferenceItem key={reference.refId} reference={reference} />
      ))}
    </section>
  );
}
