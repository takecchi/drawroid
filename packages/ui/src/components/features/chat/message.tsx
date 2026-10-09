import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import type { Author } from '../record';

/** 流れている間だけ末尾に出す印 */
function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.1em] w-1.5 animate-pulse bg-foreground/60 align-text-bottom"
    />
  );
}

/**
 * 発言1件。人間は右に寄せた吹き出し、AI は左に地のまま置く: 長い返答を吹き出しに閉じ込めると読みにくく、
 * 誰の発言かは寄せる側で分かるため。
 */
export function MessageRow({
  author,
  streaming = false,
  truncated = false,
  meta,
  action,
  children,
}: {
  author: Author;
  /** 確定していない（増分が流れている）間 */
  streaming?: boolean;
  /** 中断や割り込みで打ち切られた */
  truncated?: boolean;
  /** 時刻など */
  meta?: ReactNode;
  /** 「送り直す」など、行に添える操作 */
  action?: ReactNode;
  children: ReactNode;
}) {
  const human = author === 'human';
  return (
    <div
      data-author={author}
      className={cn('flex flex-col gap-1', human ? 'items-end' : 'items-start')}
    >
      <div
        className={cn(
          'max-w-[85%] text-sm leading-relaxed break-words whitespace-pre-wrap',
          human ? 'rounded-2xl rounded-br-md bg-primary px-4 py-2 text-primary-foreground' : 'px-1',
        )}
      >
        {children}
        {streaming && <StreamingCaret />}
      </div>
      {(truncated || meta !== undefined || action !== undefined) && (
        <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
          {truncated && <span className="text-warn">打ち切り</span>}
          {meta}
          {action}
        </div>
      )}
    </div>
  );
}

/**
 * 思考。流れている間は開いて見せ、確定したら畳む（開き直せる）。
 * 畳むのは確定したときの1度だけ: 人間が開いたものを、次の描き直しで閉じてしまわないため。
 */
export function ReasoningBlock({
  label = '思考',
  streaming = false,
  children,
}: {
  /** 誰の思考か（「考える役の思考」など） */
  label?: string;
  streaming?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(streaming);
  const [wasStreaming, setWasStreaming] = useState(streaming);
  // 描画の中で前の値と比べる: effect で合わせると、確定した直後に開いたままの1コマが挟まるため
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    setOpen(streaming);
  }
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group max-w-[85%] rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground"
    >
      <summary className="cursor-pointer select-none hover:text-foreground">
        {label}
        {streaming && <span className="ml-2 animate-pulse">…</span>}
      </summary>
      <div className="mt-1.5 leading-relaxed break-words whitespace-pre-wrap">
        {children}
        {streaming && <StreamingCaret />}
      </div>
    </details>
  );
}
