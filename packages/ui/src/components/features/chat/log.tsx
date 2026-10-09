import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

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
  const contentRef = useRef<HTMLDivElement>(null);
  // 描き直しを起こさない値で持つ: 背が伸びたときの観測の中から読むため
  const following = useRef(true);
  const lastTop = useRef(0);
  useEffect(() => {
    const element = ref.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [followKey]);
  // 行が増えなくても背は伸びる（画像があとから読み込まれる・カードが開く）。伸びたときも末尾を追う
  useEffect(() => {
    const element = ref.current;
    const content = contentRef.current;
    if (element === null || content === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      role="log"
      aria-label="会話のログ"
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        // 末尾から遠いだけでは追うのをやめない: 末尾へ動かした出来事が届くまでに画像の背が伸びると、
        // 人が何もしていなくても遠く見えるため。やめるのは、人が上へ戻した（位置が上に動いた）ときだけ
        if (distance < FOLLOW_THRESHOLD_PX) following.current = true;
        else if (element.scrollTop < lastTop.current) following.current = false;
        lastTop.current = element.scrollTop;
      }}
      // スクロールの錨止めを切る: 上の行の背が伸びるとブラウザが位置をずらし、その出来事を人が上へ戻ったと読んでしまうため
      className={cn('min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]', className)}
    >
      <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        {children}
      </div>
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
}: {
  header?: ReactNode;
  log: ReactNode;
  composer: ReactNode;
}) {
  return (
    <div className="flex h-[calc(100dvh-3.25rem)] flex-col">
      {header !== undefined && (
        <div className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2">{header}</div>
        </div>
      )}
      {log}
      <div className="border-t border-border bg-background">
        <div className="mx-auto max-w-3xl px-4 py-3">{composer}</div>
      </div>
    </div>
  );
}
