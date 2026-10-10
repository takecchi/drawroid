import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../../common';

import { STATUS_TEXT, type ChatStatus } from './cards';

/**
 * 行の数がこれを超えた会話だけ、画面の外の行の配置と描画を飛ばす（LogRow）。
 * 短い会話では飛ばさない: 飛ばすと、画面に入るたびに行を描き起こすぶん、速いスクロールが重くなる（CPU 4x で、フレームの p95 が
 * 16.8 → 33.4 ms）。線は CPU 4x で測って決めた: 飛ばさない場合、流れている間に 20 ms を超えるフレームは 300 行で 3〜10%（困らない）、
 * 350 行で 14〜21%、400 行で 33〜36%。飛ばすと 350 行で 2〜8%、400 行で 8〜15% に下がる。得が損を上回るのは 300 行より長い会話だった
 */
export const SKIP_OFFSCREEN_AFTER_ROWS = 300;

// 末尾からこの距離より近ければ「末尾を見ている」とみなす: ちょうど末尾でなくても、読んでいる人を置き去りにしないため
const FOLLOW_THRESHOLD_PX = 48;

// 人がログを動かそうとしてから、これより短い間に起きた上への動きは、人が動かしたと見る（ms）
const TOUCH_WINDOW_MS = 1000;
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/**
 * ログの1行の入れ物。会話が長い間（ChatLog の `rowCount` が SKIP_OFFSCREEN_AFTER_ROWS を超える間）は、画面の外にある間の配置と描画を飛ばす（content-visibility: auto）:
 * 長い会話では、増分のたびに数千行ぶんの配置と描画が走り、描き直し1回の大半を占めるため。
 * 行は DOM に残るので、ページの中の検索（Ctrl+F）と読み上げは、画面の外の古い発言にも届く。
 *
 * 画面の外にある間の背は、いちど描いた背を覚えて使う（contain-intrinsic-size の auto）。まだ描いていない行は見積もりの背で置く:
 * 見積もりが実際の背から遠いほど、上へ戻したときに行がずれるので、行の種類ごとの見積もりを渡す（狭い画面と広い画面で別々に）。
 */
export function LogRow({
  estimate,
  wideEstimate = estimate,
  children,
}: {
  /** 狭い画面での背の見積もり（px） */
  estimate: number;
  /** 広い画面（md 以上）での背の見積もり（px） */
  wideEstimate?: number;
  children: ReactNode;
}) {
  return (
    <div
      // 飛ばすかは、ログの側の印（data-skip-offscreen）で切り替える: 行ごとに渡すと、長さの線を越えたときに全部の行を作り直すことになるため。
      // 背の見積もり（contain-intrinsic-size）も飛ばす間だけ付ける: 短い会話でも付けると、描いた背を覚える手間が毎フレーム全部の行に掛かり、
      // 流れている間に 20 ms を超えるフレームが CPU 4x・200 行で 12% → 50% に増えたため
      className="group-data-[skip-offscreen]/log:[contain-intrinsic-size:auto_var(--row-estimate)] group-data-[skip-offscreen]/log:[content-visibility:auto] md:group-data-[skip-offscreen]/log:[contain-intrinsic-size:auto_var(--row-estimate-wide)]"
      style={
        {
          '--row-estimate': `${Math.round(estimate)}px`,
          '--row-estimate-wide': `${Math.round(wideEstimate)}px`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

/**
 * 会話のログ。末尾を見ている間だけ、行が増えたら末尾へ追従する。人間が上へ戻って読んでいる間は追従しない。
 * `followKey` が変わったら追従を見直す（行の数と、流れている本文の長さなどを渡す）。
 * 追従していない間に `followKey` が変わったら、下端に「新しい行」の印を出し、押すと末尾へ戻る。末尾へ戻れば（印でもスクロールでも）消す:
 * 上を読んでいる間に、止めた・描き終えたなどの行が下に増えても、気づけないため
 */
export function ChatLog({
  followKey,
  rowCount = 0,
  className,
  children,
}: {
  followKey: unknown;
  /** ログの行（LogRow）の数。SKIP_OFFSCREEN_AFTER_ROWS を超えたら、画面の外の行の描画を飛ばす */
  rowCount?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 描き直しを起こさない値で持つ: 背が伸びたときの観測の中から読むため
  const following = useRef(true);
  // 画面の外の描画を飛ばし始めるのは、線を越えて、かつ末尾を追っているときだけ。一度始めたら、線より短くなるまで続ける。
  // 上を読んでいる間に越えても始めない: 飛ばし始めた瞬間、描いた背を覚えていない上の行が見積もりの背に縮み、読んでいる行が大きくずれるため
  // （末尾を追っている間なら、末尾へ寄せ直すので画面は動かない）
  const skipping = useRef(false);
  if (rowCount <= SKIP_OFFSCREEN_AFTER_ROWS) skipping.current = false;
  else if (following.current) skipping.current = true;
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  // 人がログを動かそうとした（ホイール・なぞる・スクロールのキー・スクロールバー）最後の時刻
  const lastTouched = useRef(Number.NEGATIVE_INFINITY);
  // 追従していない間に増えた行があるか（「新しい行」の印を出すか）
  const [unseen, setUnseen] = useState(false);
  const touched = () => {
    lastTouched.current = performance.now();
  };
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else setUnseen(true);
  }, [followKey]);
  const jumpToEnd = () => {
    const element = ref.current;
    if (element === null) return;
    following.current = true;
    element.scrollTop = element.scrollHeight;
    setUnseen(false);
    // 押した印は消えるので、フォーカスをログへ移す: 移さないと body に落ち、キーボードではどこにいるか分からなくなるため
    element.focus({ preventScroll: true });
  };
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
      // スクリプトからだけフォーカスを受ける（「新しい行」の印を押したあとの行き先）。Tab の並びには入れない
      tabIndex={-1}
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        // 末尾から遠いだけでは追うのをやめない: 末尾へ動かした出来事が届くまでに画像の背が伸びると、
        // 人が何もしていなくても遠く見えるため。やめるのは、人が上へ戻した（位置が上に動いた）ときだけ
        // 下へ動かしたときは、前に見たときの末尾までの距離でも見る: 末尾へ戻した出来事が届くまでに、画面に入った行が
        // 見積もりの背より高く描かれると（長い会話で画面の外の描画を飛ばしているとき）、末尾まで戻したのに遠く見えるため
        const grown = element.scrollHeight - lastHeight.current;
        const movedDown = element.scrollTop > lastTop.current;
        const movedUp = lastTop.current - element.scrollTop;
        if (distance < FOLLOW_THRESHOLD_PX) following.current = true;
        else if (movedDown && distance - grown < FOLLOW_THRESHOLD_PX) {
          following.current = true;
          // 伸びた知らせ（ResizeObserver）はこの出来事より先に来ていて、もう来ないことがあるので、ここで末尾まで寄せる
          element.scrollTop = element.scrollHeight;
        } else if (
          following.current &&
          movedUp > 0 &&
          movedUp < element.clientHeight / 2 &&
          performance.now() - lastTouched.current > TOUCH_WINDOW_MS
        ) {
          // 人が触れていないのに、末尾を追っている間に少しだけ上へ動いたのは、背の変化で引かれただけ: 行を入れ替える途中で背が
          // 一瞬縮んで測られると、位置が新しい末尾へ引かれ、その知らせが届くまでに新しい行で背が伸びて、人が戻したのと同じに見えるため。
          // 伸びた知らせはもう来たあとなので、ここで末尾まで寄せる。大きく跳んだ（ページの中の検索など）なら、人が動かしたと見る
          element.scrollTop = element.scrollHeight;
          // 上へ動いても、背が縮んだときは人が戻したとみなさない: 上の行が縮むと、位置もそのぶん上へ引かれるため
        } else if (
          element.scrollTop < lastTop.current &&
          element.scrollHeight >= lastHeight.current
        )
          following.current = false;
        lastTop.current = element.scrollTop;
        lastHeight.current = element.scrollHeight;
        if (following.current && unseen) setUnseen(false);
      }}
      onWheel={touched}
      onTouchMove={touched}
      onKeyDown={(event) => {
        if (SCROLL_KEYS.has(event.key)) touched();
      }}
      // スクロールバーを掴んだときだけ数える: 行の中のボタンを押しただけで、人が動かしたと見ないため
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) touched();
      }}
      // スクロールの錨止めを切る: 上の行の背が伸びるとブラウザが位置をずらし、その出来事を人が上へ戻ったと読んでしまうため
      className={cn('min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]', className)}
    >
      <div
        ref={contentRef}
        data-skip-offscreen={skipping.current ? '' : undefined}
        className="group/log mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6"
      >
        {children}
      </div>
      {unseen && (
        // 高さ 0 の入れ物を下端に貼り付け、ボタンはその上に重ねる: 背（scrollHeight）を変えると、人がスクロールしたかの判定が狂うため
        <div className="pointer-events-none sticky bottom-0 h-0">
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            {/* 目立つ形にする: 画像の上に重なっても見分けられるように */}
            <Button
              size="sm"
              variant="primary"
              aria-label="新しい行へ"
              onClick={jumpToEnd}
              className="pointer-events-auto shadow-md"
            >
              新しい行
              <ArrowDown aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 会話の画面の骨組み。ログが伸び、入力欄は下に留まる。
 * 高さは画面の高さから上の帯の分を引く: ページ全体を伸ばすと、入力欄が画面の外へ押し出されるため。
 * 上の帯があるのは狭い画面だけ（`MobileTopBar` の `h-14`）。広い画面の行き先は脇にあるので、画面の高さをそのまま使う。
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
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col md:h-dvh">
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
