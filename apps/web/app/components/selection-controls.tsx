import { isApiError, setSelection } from '@drawroid/swr';
import type { SelectionVerdict } from '@drawroid/core';
import { useState } from 'react';

const VERDICT_LABELS: Record<SelectionVerdict, string> = {
  favorite: 'お気に入り',
  rejected: '却下',
};

export function SelectionControls({
  jobId,
  imageKey,
  verdict,
}: {
  jobId: string;
  imageKey: string;
  verdict: SelectionVerdict | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function choose(next: SelectionVerdict | null) {
    setPending(true);
    setError(undefined);
    try {
      await setSelection(jobId, imageKey, next);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <p>今の状態: {verdict === null ? '未選択' : VERDICT_LABELS[verdict]}</p>
      <button
        type="button"
        disabled={pending || verdict === 'favorite'}
        onClick={() => void choose('favorite')}
      >
        お気に入り
      </button>{' '}
      <button
        type="button"
        disabled={pending || verdict === 'rejected'}
        onClick={() => void choose('rejected')}
      >
        却下
      </button>{' '}
      <button
        type="button"
        disabled={pending || verdict === null}
        onClick={() => void choose(null)}
      >
        外す
      </button>
      {error !== undefined && <p role="alert">選べない: {error}</p>}
    </div>
  );
}
