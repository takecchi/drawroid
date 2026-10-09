import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { STATUS_TEXT, type ChatStatus } from './cards';

// 末尾からこの距離より近ければ「末尾を見ている」とみなす: ちょうど末尾でなくても、読んでいる人を置き去りにしないため
const FOLLOW_THRESHOLD_PX = 48;

/**
 * 会話のログ。末尾を見ている間だけ、行が増えたら末尾へ追従する。人間が上へ戻って読んでいる間は追従しない。
 * `followKey` が変わったら追従を見直す（行の数と、流れている本文の長さなどを渡す）。
 */
export function ChatLog({
  followKey,
  className,
  children,
}: {
  followKey: unknown;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (element !== null && following) element.scrollTop = element.scrollHeight;
  }, [following, followKey]);
  return (
    <div
      ref={ref}
      role="log"
      aria-label="会話のログ"
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setFollowing(distance < FOLLOW_THRESHOLD_PX);
      }}
      className={cn('min-h-0 flex-1 overflow-y-auto', className)}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">{children}</div>
    </div>
  );
}

/**
 * 会話の画面の骨組み。ログが伸び、入力欄は下に留まる。
 * 高さは画面の高さから上の帯の分を引く: ページ全体を伸ばすと、入力欄が画面の外へ押し出されるため。
 */
export function ChatLayout({
  header,
  log,
  composer,
  status,
}: {
  header?: ReactNode;
  log: ReactNode;
  composer: ReactNode;
  /** 今の状態。見えない場所で読み上げに知らせる（見える1行は StatusLine） */
  status?: ChatStatus;
}) {
  return (
    <div className="flex h-[calc(100dvh-3.25rem)] flex-col">
      {header !== undefined && (
        <div className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2">{header}</div>
        </div>
      )}
      {log}
      {/* 状態が無い間も置いておく: 読み上げは、すでにある場所の中身の変化だけを確実に伝えるため */}
      <div role="status" aria-live="polite" className="sr-only">
        {status === undefined ? '' : STATUS_TEXT[status]}
      </div>
      <div className="border-t border-border bg-background">
        <div className="mx-auto max-w-3xl px-4 py-3">{composer}</div>
      </div>
    </div>
  );
}
