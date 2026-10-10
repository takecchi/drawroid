import { adoptImage, isApiError } from '@drawroid/swr';
import { Button } from '@drawroid/ui';
import { useEffect, useRef, useState } from 'react';

import { DecidedMark } from './decided-mark';

type State =
  | { step: 'idle' }
  | { step: 'confirming' }
  | { step: 'sending' }
  | { step: 'done' }
  | { step: 'failed'; message: string };

/**
 * 「採る」ボタン。描いている絵を、この画像に決める（会話の adopt_image と同じ口: POST /jobs/:jobId/adopt）。
 * 押すとまず確かめ、決めたら「この画像に決めた」と出す。走っているジョブにだけ出す（止まったジョブは採る口を受けないので、呼び手が ChooseAsFavorite を出す）。
 */
// 確かめを挟む: 採るとジョブが止まる（続きの指示が無ければ）ので、押し間違いで描くのを終わらせないため。
// 会話の「選んだ」（job.adopted）とジョブの止まった理由は、会話のイベントとして別に出る
export function AdoptButton({
  jobId,
  image,
  imageLabel,
  chosen = false,
  onDecided,
  onConfirmingChange,
}: {
  jobId: string;
  image: { iteration: number; index: number };
  /** どの画像のボタンか（「2 回目の画像 1 番」）。読み上げで、どの画像も同じ「採る」にならないように */
  imageLabel: string;
  /** この画像で決まった（会話の job.adopted・回の adopted）。押した直後だけでなく、開き直しても同じに出すため */
  chosen?: boolean;
  /** このボタンで決めたとき。呼び手は、記録（chosen）が追いつく前にジョブが止まっても、このボタンを出し続ける */
  onDecided?: () => void;
  /** 確かめを出している間か。呼び手は、確かめている間にジョブが止まったら、お気に入りの口でその訳を出す */
  onConfirmingChange?: (confirming: boolean) => void;
}) {
  const [state, setState] = useState<State>({ step: 'idle' });
  const confirming = state.step === 'confirming' || state.step === 'sending';
  useEffect(() => {
    onConfirmingChange?.(confirming);
  }, [confirming, onConfirmingChange]);
  // 押したボタンは次の形（確かめ・印）に替わって消える。人が押して形が替わったときだけ、次の形の先頭へフォーカスを移す
  // （移さないとページの外に落ちる。押していないのに替わったとき、たとえば会話で別に決まったときは移さない）
  const pressed = useRef(false);
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // 送っている間はボタンが押せないので待つ。決めたあとは印（DecidedMark）が自分で受ける
    if (!pressed.current || state.step === 'sending' || state.step === 'done') return;
    firstButton.current?.focus();
  }, [state.step]);
  function press(next: State) {
    pressed.current = true;
    setState(next);
  }

  async function adopt() {
    setState({ step: 'sending' });
    try {
      await adoptImage(jobId, image);
      setState({ step: 'done' });
      onDecided?.();
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setState({ step: 'failed', message: caught.message });
    }
  }

  if (state.step === 'done' || chosen) {
    return <DecidedMark focus={state.step === 'done'} />;
  }
  if (state.step === 'confirming' || state.step === 'sending') {
    return (
      <div className="space-y-1" role="group" aria-label={`${imageLabel}に決めるかの確かめ`}>
        <p className="text-xs">
          {imageLabel}に決める？ 続きの指示が無ければ、描くのはここで止まる。
        </p>
        <div className="flex flex-wrap gap-1">
          <Button
            ref={firstButton}
            size="sm"
            variant="primary"
            disabled={state.step === 'sending'}
            aria-label={`決める: ${imageLabel}`}
            onClick={() => void adopt()}
          >
            決める
          </Button>
          <Button
            size="sm"
            disabled={state.step === 'sending'}
            onClick={() => press({ step: 'idle' })}
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
        ref={firstButton}
        size="sm"
        aria-label={`この画像に決める: ${imageLabel}`}
        onClick={() => press({ step: 'confirming' })}
      >
        この画像に決める
      </Button>
      {state.step === 'failed' && (
        <p className="text-xs text-destructive">決められない: {state.message}</p>
      )}
    </div>
  );
}
