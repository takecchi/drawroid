import type { SelectionVerdict } from '@drawroid/core';
import { isApiError, recheckJobDistill, setSelection } from '@drawroid/swr';
import { Button } from '@drawroid/ui';
import { useState } from 'react';

import { DecidedMark } from './decided-mark';

/**
 * 止まったジョブの画像で「この画像に決める（お気に入りにする）」。会話（止まりのカード・画像の行・大きく見る窓）とジョブの詳細が同じものを使う。
 * 止まったジョブは採る口（adopt）を受けない（止まったら受けない約束。API は 409）ので、決めるのはお気に入りの口で行う。
 * すでにお気に入りなら、ボタンの代わりに「この画像に決めた（お気に入り）」と出す
 */
export function ChooseAsFavorite({
  jobId,
  imageKey,
  imageLabel,
  verdict,
  prominent = false,
}: {
  jobId: string;
  imageKey: string;
  imageLabel: string;
  verdict: SelectionVerdict | null;
  /**
   * 目立つ形（紫）にする。止まりのカードだけが渡す: 止まったジョブの画像の行と窓にも同じボタンが並ぶので、
   * どれも紫だと、どれを押せばよいかが分からなくなるため。行と窓は控えめな形（枠だけ）で、名前は同じ
   */
  prominent?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // このボタンで決めたか。決めた印へフォーカスを移すのは、押したこのボタンの所だけ（同じ画像の印は、カード・行・窓に並ぶ）
  const [chose, setChose] = useState(false);
  // 印が外れたら（お気に入りを外した）忘れる: 覚えたままだと、あとで別の所で決めたときに、ここの印がフォーカスを奪うため
  if (chose && verdict !== 'favorite' && !pending) setChose(false);
  async function choose() {
    setPending(true);
    setError(undefined);
    try {
      await setSelection(jobId, imageKey, 'favorite');
      setChose(true);
      // 止まったジョブで選び直すと、選び直しの蒸留が裏で走る。そのジョブの「覚えたこと」を、開き直さずに読み直させる
      void recheckJobDistill(jobId);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }
  // 止まったジョブでは、お気に入りにした画像を決めた画像として印を出す（カード・行・窓・ジョブの詳細のどこでも）。
  // 押した直後の手元の状態でなく保存された選び方から出す: 開き直しても、別の場所で押しても同じに出すため
  if (verdict === 'favorite') return <DecidedMark favorite focus={chose} />;
  return (
    <div className="space-y-1">
      {/* 折り返すのは言葉のかたまりの境目だけ: ボタンの中でそのまま折り返すと、日本語はどの字の間でも折れ、
          「決め / る」のように言葉の途中で切れるため。画像の枡は狭いので短い文にし、お気に入りになることは名前と title に残す */}
      <Button
        className="h-auto min-h-11 max-w-full px-2 py-1 text-left text-xs whitespace-normal md:min-h-7"
        variant={prominent ? 'primary' : 'default'}
        disabled={pending}
        aria-label={`この画像に決める（お気に入りにする）: ${imageLabel}`}
        title="お気に入りにする"
        onClick={() => void choose()}
      >
        {/* 1つの span で包む: ボタンは flex なので、かたまりを直に並べると別々の子になり、横に並んだまま折り返さないため */}
        <span className="min-w-0">
          <span className="inline-block whitespace-nowrap">この画像に決める</span>
          {prominent && (
            <>
              <wbr />
              <span className="inline-block whitespace-nowrap">（お気に入りにする）</span>
            </>
          )}
        </span>
      </Button>
      {error !== undefined && <p className="text-xs text-destructive">決められない: {error}</p>}
    </div>
  );
}
