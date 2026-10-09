import { Check, Loader2, Paintbrush, Wrench, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { BulletList } from '../../common';
import { AuthorMark, ImageCard, ImageGrid, type ImageVerdict } from '../record';

/** ログの中のカードの共通の枠。発言より一段控えめにする: 主役は発言で、カードはその裏で起きたことの記録のため */
function LogCard({
  icon,
  title,
  aside,
  label,
  className,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  /** 読み上げでの、カードのまとまりの名前 */
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={label === undefined ? undefined : 'group'}
      aria-label={label}
      className={cn('max-w-[85%] rounded-lg border border-border bg-card text-sm', className)}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {aside}
      </div>
      {children !== undefined && (
        <div className="space-y-1.5 border-t border-border px-3 py-2">{children}</div>
      )}
    </div>
  );
}

export type ToolCallState = 'running' | 'ok' | 'error';

const TOOL_STATE = {
  running: { icon: <Loader2 className="animate-spin" />, label: '実行中', className: '' },
  ok: { icon: <Check />, label: '済み', className: 'text-ok' },
  error: { icon: <X />, label: '失敗', className: 'text-destructive' },
} as const;

/** ツールの呼び出しと結果。結果が来るまでは「実行中」 */
export function ToolCallCard({
  name,
  args,
  state,
  result,
}: {
  name: string;
  /** 引数の要約（1行） */
  args?: string;
  state: ToolCallState;
  /** 結果の要約 */
  result?: ReactNode;
}) {
  const { icon, label, className } = TOOL_STATE[state];
  return (
    <LogCard
      icon={<Wrench />}
      title={<span className="font-mono text-xs">{name}</span>}
      label={`ツール ${name}: ${label}`}
      aside={
        <span
          className={cn('flex shrink-0 items-center gap-1 text-xs [&_svg]:size-3.5', className)}
        >
          {icon}
          {label}
        </span>
      }
    >
      {args !== undefined && (
        <div className="font-mono text-xs break-all text-muted-foreground">{args}</div>
      )}
      {result !== undefined && <div className="break-words whitespace-pre-wrap">{result}</div>}
    </LogCard>
  );
}

/** 描き始め。依頼の要点と止める条件を出す。ジョブの詳細へのリンクは画面が渡す */
export function JobStartCard({
  request,
  conditions,
  permissions,
  link,
}: {
  request: string;
  conditions: string[];
  permissions?: string;
  link?: ReactNode;
}) {
  return (
    <LogCard icon={<Paintbrush />} title="描き始めた" aside={link}>
      <p className="break-words">{request}</p>
      {conditions.length > 0 && (
        <div className="text-xs text-muted-foreground">止める条件: {conditions.join('・')}</div>
      )}
      {permissions !== undefined && (
        <div className="text-xs text-muted-foreground">許可: {permissions}</div>
      )}
    </LogCard>
  );
}

function formatEta(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `残り約 ${seconds} 秒` : `残り約 ${Math.round(seconds / 60)} 分`;
}

/**
 * 生成の進み具合。割合が無い（バックエンドが進み具合を返さない）ときは「生成中」とだけ出す。
 */
export function GenerationProgress({
  iteration,
  progress,
  step,
  steps,
  etaMs,
  previewSrc,
  hint,
}: {
  iteration?: number;
  /** 0〜1 */
  progress?: number;
  step?: number;
  steps?: number;
  etaMs?: number;
  /** 途中の画像（設定で有効なときだけ） */
  previewSrc?: string;
  /** カードの下に添える一言（「できあがったら、画像の行で選べます」など） */
  hint?: ReactNode;
}) {
  const percent = progress === undefined ? undefined : Math.round(progress * 100);
  const details = [
    step !== undefined && steps !== undefined ? `${step} / ${steps} ステップ` : undefined,
    etaMs !== undefined ? formatEta(etaMs) : undefined,
  ].filter((part) => part !== undefined);
  return (
    <LogCard
      icon={<Loader2 className="animate-spin" />}
      title={iteration === undefined ? '生成中' : `${iteration} 回目を生成中`}
      aside={
        percent !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{percent}%</span>
        )
      }
    >
      <div
        role="progressbar"
        aria-label="生成の進み具合"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-[width] duration-500',
            percent === undefined && 'w-1/3 animate-pulse',
          )}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      {details.length > 0 && (
        <div className="text-xs text-muted-foreground tabular-nums">{details.join(' ・ ')}</div>
      )}
      {previewSrc !== undefined && (
        <img
          src={previewSrc}
          alt={iteration === undefined ? '途中の画像' : `${iteration} 回目の途中の画像`}
          className="size-32 rounded-md border border-border object-cover"
        />
      )}
      {hint !== undefined && <div className="text-xs text-muted-foreground">{hint}</div>}
    </LogCard>
  );
}

/** 考える役の決定。短い理由と、変えたものだけを出す（全部のパラメータはジョブの詳細で見る） */
export function ThinkNote({
  iteration,
  rationale,
  changes = [],
}: {
  iteration: number;
  rationale: string;
  changes?: string[];
}) {
  return (
    <AuthorMark author="ai" label={`考える役（${iteration} 回目）`} className="max-w-[85%]">
      <p className="break-words">{rationale}</p>
      {changes.length > 0 && (
        <BulletList className="text-xs text-muted-foreground">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </BulletList>
      )}
    </AuthorMark>
  );
}

/**
 * 見る役の評価を、決まった型の文にして出す。見る役に人間向けの一言を書かせない
 * （出力が増え、欄の値とずれうるため。設計書の推奨6）。
 */
export function JudgeNote({
  iteration,
  canStop,
  nextChange,
  adopted,
}: {
  iteration: number;
  canStop: boolean;
  nextChange?: string;
  /** 人間が選んで評価を打ち切ったときの、選ばれた画像（number は 1 から数えた番号） */
  adopted?: { iteration: number; number: number };
}) {
  const text = adopted
    ? `この回は、人間が選んだ画像（${adopted.iteration} 回目の画像 ${adopted.number} 番）で決まり。`
    : canStop
      ? 'これで意図どおりと見ている。'
      : `ちょっと違う。${nextChange === undefined ? '' : `次は「${nextChange}」。`}`;
  return (
    <AuthorMark author="ai" label={`見る役（${iteration} 回目）`} className="max-w-[85%]">
      <p className="break-words">{text}</p>
    </AuthorMark>
  );
}

export interface ImageRowItem {
  key: string;
  href: string;
  src: string;
  alt: string;
  score?: string;
  issues?: string[];
  verdict?: ImageVerdict | null;
  /** お気に入り・却下などの操作。画面が渡す */
  actions?: ReactNode;
}

/** 1回ぶんの画像。評価が来ていれば点数と問題点を重ねる */
export function ImageRow({
  iteration,
  images,
  link,
}: {
  iteration: number;
  images: ImageRowItem[];
  /** ジョブの詳細へのリンク。画面が渡す */
  link?: ReactNode;
}) {
  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{iteration} 回目の画像</span>
        {link}
      </div>
      <ImageGrid>
        {images.map((image) => (
          <ImageCard
            key={image.key}
            href={image.href}
            src={image.src}
            alt={image.alt}
            verdict={image.verdict}
            caption={
              (image.score !== undefined || (image.issues?.length ?? 0) > 0) && (
                <>
                  {image.score !== undefined && <div>score {image.score}</div>}
                  {image.issues !== undefined && image.issues.length > 0 && (
                    <BulletList className="text-xs">
                      {image.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </BulletList>
                  )}
                </>
              )
            }
          >
            {image.actions}
          </ImageCard>
        ))}
      </ImageGrid>
    </div>
  );
}

const STOP_TONES = {
  done: 'border-ok/40 bg-ok/5 text-ok',
  stopped: 'border-border bg-muted text-muted-foreground',
  error: 'border-destructive/40 bg-destructive/5 text-destructive',
} as const;

/** 止まった・終わった・失敗した、の知らせ。ログの中に1行で置く */
export function StopNotice({
  tone,
  action,
  children,
}: {
  tone: keyof typeof STOP_TONES;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'flex max-w-[85%] flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-xs',
        STOP_TONES[tone],
      )}
    >
      <span className="min-w-0 break-words">{children}</span>
      {action}
    </div>
  );
}

export type ChatStatus = 'queued' | 'waiting-llm' | 'job.held';

export const STATUS_TEXT: Record<ChatStatus, string> = {
  queued: '順番を待っています',
  'waiting-llm': '考えています',
  'job.held': '話を聞いています（描くのは待たせています）',
};

/**
 * 今の状態の1行。確定しないので、次の状態か確定したイベントで消える。
 * 読み上げには出さない: 現れては消える要素の変化は読み上げに届きにくいので、ChatLayout の常にある場所で知らせる。
 */
export function StatusLine({ status }: { status: ChatStatus }) {
  return (
    <div aria-hidden className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
      {STATUS_TEXT[status]}
    </div>
  );
}
