import { adoptImage, isApiError } from '@drawroid/swr';
import { Button } from '@drawroid/ui';
import { useState } from 'react';

type State =
  | { step: 'idle' }
  | { step: 'confirming' }
  | { step: 'sending' }
  | { step: 'done' }
  | { step: 'failed'; message: string };

/**
 * 「採る」ボタン。描いている絵を、この画像で決める（会話の adopt_image と同じ口: POST /jobs/:jobId/adopt）。
 * 押すとまず確かめ、決めたら「選んだ」と出す。ジョブがもう止まっているときは押せず、理由を出す。
 */
// 確かめを挟む: 採るとジョブが止まる（続きの指示が無ければ）ので、押し間違いで描くのを終わらせないため。
// 会話の「選んだ」（job.adopted）とジョブの止まった理由は、会話のイベントとして別に出る
export function AdoptButton({
  jobId,
  image,
  imageLabel,
  disabledReason,
  chosen = false,
}: {
  jobId: string;
  image: { iteration: number; index: number };
  /** どの画像のボタンか（「2 回目の画像 1 番」）。読み上げで、どの画像も同じ「採る」にならないように */
  imageLabel: string;
  /** 押せない理由（ジョブが止まった、など）。あれば押せず、理由を出す */
  disabledReason?: string;
  /** この画像で決まった（会話の job.adopted・回の adopted）。押した直後だけでなく、開き直しても同じに出すため */
  chosen?: boolean;
}) {
  const [state, setState] = useState<State>({ step: 'idle' });
  const small = 'h-7 px-2 text-xs';

  async function adopt() {
    setState({ step: 'sending' });
    try {
      await adoptImage(jobId, image);
      setState({ step: 'done' });
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setState({ step: 'failed', message: caught.message });
    }
  }

  if (state.step === 'done' || chosen) {
    return <p className="text-xs text-muted-foreground">この画像で決めた（選んだ）</p>;
  }
  if (disabledReason !== undefined) {
    return (
      <div className="space-y-1">
        <Button className={small} disabled aria-label={`この画像で決める: ${imageLabel}`}>
          この画像で決める
        </Button>
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      </div>
    );
  }
  if (state.step === 'confirming' || state.step === 'sending') {
    return (
      <div className="space-y-1" role="group" aria-label={`${imageLabel}で決めるかの確かめ`}>
        <p className="text-xs">
          {imageLabel}で決める？ 続きの指示が無ければ、描くのはここで止まる。
        </p>
        <div className="flex flex-wrap gap-1">
          <Button
            className={small}
            variant="primary"
            disabled={state.step === 'sending'}
            aria-label={`決める: ${imageLabel}`}
            onClick={() => void adopt()}
          >
            決める
          </Button>
          <Button
            className={small}
            disabled={state.step === 'sending'}
            onClick={() => setState({ step: 'idle' })}
          >
            やめる
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Button
        className={small}
        aria-label={`この画像で決める: ${imageLabel}`}
        onClick={() => setState({ step: 'confirming' })}
      >
        この画像で決める
      </Button>
      {state.step === 'failed' && (
        <p className="text-xs text-destructive">決められない: {state.message}</p>
      )}
    </div>
  );
}
