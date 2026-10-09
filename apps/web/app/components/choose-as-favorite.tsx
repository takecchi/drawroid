import type { SelectionVerdict } from '@drawroid/core';
import { isApiError, recheckJobDistill, setSelection } from '@drawroid/swr';
import { Button } from '@drawroid/ui';
import { useState } from 'react';

/**
 * 止まったジョブの画像で「この画像に決める（お気に入りにする）」。会話（止まりのカード・画像の行・大きく見る窓）とジョブの詳細が同じものを使う。
 * 止まったジョブは採る口（adopt）を受けない（止まったら受けない約束。API は 409）ので、決めるのはお気に入りの口で行う。
 * すでにお気に入りなら、ボタンの代わりに「お気に入り」と出す
 */
export function ChooseAsFavorite({
  jobId,
  imageKey,
  imageLabel,
  verdict,
}: {
  jobId: string;
  imageKey: string;
  imageLabel: string;
  verdict: SelectionVerdict | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  async function choose() {
    setPending(true);
    setError(undefined);
    try {
      await setSelection(jobId, imageKey, 'favorite');
      // 止まったジョブで選び直すと、選び直しの蒸留が裏で走る。そのジョブの「覚えたこと」を、開き直さずに読み直させる
      void recheckJobDistill(jobId);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }
  if (verdict === 'favorite') return <p className="text-xs text-ok">お気に入り</p>;
  return (
    <div className="space-y-1">
      <Button
        className="h-7 px-2 text-xs"
        variant="primary"
        disabled={pending}
        aria-label={`この画像に決める（お気に入りにする）: ${imageLabel}`}
        onClick={() => void choose()}
      >
        この画像に決める（お気に入りにする）
      </Button>
      {error !== undefined && <p className="text-xs text-destructive">決められない: {error}</p>}
    </div>
  );
}
