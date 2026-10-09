import { formatImageKey, LLM_NOT_CONFIGURED_REASON, type SelectionVerdict } from '@drawroid/core';
import {
  isApiError,
  jobImageUrls,
  setSelection,
  useJob,
  useJobDistill,
  useSelections,
  type ReferenceUpload,
} from '@drawroid/swr';
import {
  BulletList,
  Button,
  ChatComposer,
  ChatLayout,
  ChatLog,
  ErrorNote,
  GenerationProgress,
  ImageRow,
  JobStartCard,
  ImageViewer,
  JudgeNote,
  LogRow,
  MessageRow,
  Muted,
  ReasoningBlock,
  StatusLine,
  StopNotice,
  ThinkNote,
  ToolCallCard,
  type ViewerImage,
} from '@drawroid/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import {
  chatItems,
  currentStatus,
  isRunning,
  type ChatImage,
  type ChatItem,
} from '../lib/chat-state';
import { useConversationStream, type ConversationSource } from '../lib/conversation-stream';
import { formatScore } from '../lib/format';
import { stoppedByBackend, useRecheckBackendOnFailure } from '../lib/recheck-backend';
import { describeStopConditions } from '../lib/stop-conditions-form';
import { summarizeStopReason } from '../lib/stop-reason';
import { buildReferenceUpload, referenceFileProblem } from '../lib/reference-upload';
import { AdoptButton } from './adopt-button';
import { MaskSurface, MaskTools, useMaskPainting } from './mask-painter';
import { SetupNotice } from './setup-notice';

/** 発言と止めるの送り先。どちらも HTTP API（会話 C）に乗る。画面にだけある経路は作らない */
export interface ConversationActions {
  /** attachments は、upload で会話へ送り込んだ画像の ID */
  send(text: string, clientMessageId: string, attachments?: { uploadId: string }[]): Promise<void>;
  stop(): Promise<void>;
  /** 添える画像を1枚会話へ送り込み、ID を返す。無ければ画像を添えられない */
  upload?(image: ReferenceUpload): Promise<string>;
}

/** 入力欄に添えた画像。縮小版の object URL は、外す・送る・画面を離れるときに片付ける */
interface PendingAttachment {
  id: string;
  file: File;
  url: string;
}

/** 設定の画面の欄への道。名前は設定の画面の欄の名前にそろえる */
function SettingsLink({ to }: { to: 'llm' | 'backend' }) {
  return (
    <Link
      to={`/settings#${to}`}
      className="text-xs text-primary underline-offset-4 hover:underline"
    >
      {to === 'llm' ? 'LLM の設定へ' : 'バックエンドの設定へ'}
    </Link>
  );
}

/** 設定を直せば直るバックエンドの失敗（繋がらない・URL が違う・認証・応答が無い） */
const BACKEND_SETUP_ERRORS: ReadonlySet<string> = new Set([
  'unreachable',
  'not_found',
  'unauthorized',
  'timeout',
]);

function JobLink({ jobId }: { jobId: string }) {
  return (
    <Link to={`/jobs/${jobId}`} className="text-xs text-primary underline-offset-4 hover:underline">
      ジョブの詳細
    </Link>
  );
}

function VerdictButtons({
  jobId,
  imageKey,
  imageLabel,
  verdict,
}: {
  jobId: string;
  imageKey: string;
  /** どの画像のボタンか（「2 回目の画像 1 番」）。読み上げでは、どの画像も同じ「お気に入り」になってしまうため */
  imageLabel: string;
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
  const small = 'h-7 px-2 text-xs';
  const favorite = verdict === 'favorite' ? 'お気に入りを外す' : 'お気に入り';
  const reject = verdict === 'rejected' ? '却下を外す' : '却下';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {/* 読み上げの名前は見える文言で始める: 声で操作する人が、見えている文言で呼べるように */}
        <Button
          className={small}
          disabled={pending}
          aria-pressed={verdict === 'favorite'}
          aria-label={`${favorite}: ${imageLabel}`}
          onClick={() => void choose(verdict === 'favorite' ? null : 'favorite')}
        >
          {favorite}
        </Button>
        <Button
          className={small}
          disabled={pending}
          aria-pressed={verdict === 'rejected'}
          aria-label={`${reject}: ${imageLabel}`}
          onClick={() => void choose(verdict === 'rejected' ? null : 'rejected')}
        >
          {reject}
        </Button>
      </div>
      {error !== undefined && <p className="text-xs text-destructive">選べない: {error}</p>}
    </div>
  );
}

/** 1枚の画像への選び方（お気に入り・却下と「この画像で決める」）。画像の行と、大きく見る窓の両方に置く（同じ口を呼ぶ） */
function ImageChoices({
  jobId,
  iteration,
  index,
  verdict,
  stopped,
  chosen,
}: {
  jobId: string;
  iteration: number;
  index: number;
  verdict: SelectionVerdict | null;
  /** ジョブが止まった。採る口（adopt）は使わず、決めるのはお気に入りの口で行う */
  stopped: boolean;
  chosen: boolean;
}) {
  const imageKey = formatImageKey({ iteration, index });
  // 1 から数える: 人が選んだ回の表示（「N 回目の画像 M 番」）と同じ呼び方にするため
  const imageLabel = `${iteration} 回目の画像 ${index + 1} 番`;
  return (
    <div className="space-y-1">
      <VerdictButtons jobId={jobId} imageKey={imageKey} imageLabel={imageLabel} verdict={verdict} />
      {/* 止まったジョブは採る口を受けない（止まったら受けない約束。API は 409）ので、止まりのカードと同じく、決めるのはお気に入りにする。
          人が選んで止まった画像は、選んだと出す */}
      {stopped && !chosen ? (
        <ChooseAsFavorite
          jobId={jobId}
          imageKey={imageKey}
          imageLabel={imageLabel}
          verdict={verdict}
        />
      ) : (
        <AdoptButton
          jobId={jobId}
          image={{ iteration, index }}
          imageLabel={imageLabel}
          chosen={chosen}
        />
      )}
    </div>
  );
}

/**
 * 止まったジョブの画像で「この画像に決める（お気に入りにする）」。止まりのカード・画像の行・大きく見る窓が同じものを使う。
 * すでにお気に入りなら、ボタンの代わりに「お気に入り」と出す
 */
function ChooseAsFavorite({
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

/** 大きく見る窓の画像の下: 見る役の点と言葉、選び方。選択は行と同じく今の API から読む */
function ViewerImageDetails({
  jobId,
  iteration,
  image,
  stopped,
  chosen,
  onPaint,
}: {
  jobId: string;
  iteration: number;
  image: ChatImage;
  stopped: boolean;
  chosen: boolean;
  /** 渡すと「マスクを塗る」を出す（止まっていないジョブの画像だけ） */
  onPaint?: () => void;
}) {
  const { data } = useSelections(jobId);
  const imageKey = formatImageKey({ iteration, index: image.index });
  const verdict =
    data?.selections.find((selection) => selection.imageKey === imageKey)?.verdict ?? null;
  return (
    <div className="space-y-2 text-sm">
      {(image.score !== undefined || (image.issues?.length ?? 0) > 0) && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {image.score !== undefined && <div>見る役の点 {formatScore(image.score)}</div>}
          {image.issues !== undefined && image.issues.length > 0 && (
            <BulletList className="text-xs">
              {image.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </BulletList>
          )}
        </div>
      )}
      <ImageChoices
        jobId={jobId}
        iteration={iteration}
        index={image.index}
        verdict={verdict}
        stopped={stopped}
        chosen={chosen}
      />
      {onPaint !== undefined && (
        <Button className="h-7 px-2 text-xs" onClick={onPaint}>
          マスクを塗る
        </Button>
      )}
    </div>
  );
}

const PAINTING_LOCK = '塗っている間は前後へ送れません。';
const PAINTING_HOLD =
  '塗りかけがある間は、Esc や窓の外を押しても閉じません（閉じるボタンは、塗りかけを捨てて閉じます）。';

/**
 * 会話の画像を大きく見る窓。止まっていないジョブの画像には、窓の中でマスクを塗って送れる（ジョブの詳細と同じ口）。
 * 塗っている間は前後へ送らない: 横に引いた筆が、なぞりとして次の画像への送りになるため。塗りかけがある間は、Esc と窓の外では閉じない。
 * 塗る状態はここに置く: 筆を動かすたびに、会話のログまで描き直さないように
 */
function ConversationImageViewer({
  images,
  viewing,
  onViewingChange,
  stoppedJobs,
  chosenImages,
}: {
  images: readonly (ViewerImage & { source: ViewerSource })[];
  viewing: string | null;
  onViewingChange: (key: string | null) => void;
  stoppedJobs: ReadonlySet<string>;
  chosenImages: ReadonlySet<string>;
}) {
  // 塗っている画像（窓の画像の key）。窓を閉じたら、塗りかけごと捨てる
  const [paintingKey, setPaintingKey] = useState<string | null>(null);
  const painted =
    paintingKey === null || paintingKey !== viewing
      ? undefined
      : images.find((image) => image.key === paintingKey);
  const painting = useMaskPainting(
    painted === undefined
      ? undefined
      : {
          jobId: painted.source.jobId,
          iteration: painted.source.iteration,
          index: painted.source.image.index,
        },
  );
  const holding = painted !== undefined && painting.strokes.length > 0;
  return (
    <ImageViewer
      images={images}
      openKey={viewing}
      onOpenKeyChange={(key) => {
        setPaintingKey(null);
        onViewingChange(key);
      }}
      keepOpen={holding}
      {...(painted !== undefined && {
        navigationLock: holding ? `${PAINTING_LOCK}${PAINTING_HOLD}` : PAINTING_LOCK,
        stage: (
          <MaskSurface
            src={painted.fullSrc}
            alt={painted.alt}
            painting={painting}
            imageClassName="block max-h-[50dvh] max-w-full"
            loading={<p className="text-sm text-muted-foreground">原寸の画像を読み込んでいます…</p>}
          />
        ),
      })}
      details={(image) => {
        if (painted !== undefined) {
          return (
            <div className="space-y-2">
              <MaskTools
                painting={painting}
                onClose={() => setPaintingKey(null)}
                closeLabel="塗るのをやめる"
              />
            </div>
          );
        }
        const source = images.find((candidate) => candidate.key === image.key)?.source;
        if (source === undefined) return null;
        const imageKey = formatImageKey({
          iteration: source.iteration,
          index: source.image.index,
        });
        const stopped = stoppedJobs.has(source.jobId);
        return (
          <ViewerImageDetails
            {...source}
            stopped={stopped}
            chosen={chosenImages.has(`${source.jobId}:${imageKey}`)}
            {...(!stopped && { onPaint: () => setPaintingKey(image.key) })}
          />
        );
      }}
    />
  );
}

function ImagesItem({
  item,
  stopped,
  chosenImages,
  open,
}: {
  item: Extract<ChatItem, { kind: 'images' }>;
  /** ジョブが止まった。採る口（adopt）は使わず、決めるのはお気に入りの口で行う */
  stopped: boolean;
  /** 人が選んだ画像（<jobId>:<回>-<画像>） */
  chosenImages: ReadonlySet<string>;
  /** 画像を大きく見る窓で開く（窓の画像の key） */
  open: (viewerKey: string) => void;
}) {
  // 選択は今の API（selections）から読む: 会話のイベントには選択を写さないため
  const { data } = useSelections(item.jobId);
  const verdicts = new Map(
    (data?.selections ?? []).flatMap(({ imageKey, verdict }) =>
      verdict === null ? [] : [[imageKey, verdict] as const],
    ),
  );
  return (
    <ImageRow
      iteration={item.iteration}
      link={<JobLink jobId={item.jobId} />}
      images={item.images.map((image: ChatImage) => {
        const imageKey = formatImageKey({ iteration: item.iteration, index: image.index });
        const urls = jobImageUrls(item.jobId, item.iteration, image.index);
        const verdict = verdicts.get(imageKey) ?? null;
        // 1 から数える: 人が選んだ回の表示（「N 回目の画像 M 番」）と同じ呼び方にするため
        const imageLabel = `${item.iteration} 回目の画像 ${image.index + 1} 番`;
        const viewerKey = viewerKeyOf(item.jobId, imageKey);
        return {
          key: imageKey,
          href: urls.url,
          src: urls.previewUrl,
          alt: `${imageLabel}（seed ${image.seed ?? '不明'}）`,
          viewerKey,
          onOpen: () => open(viewerKey),
          ...(item.size !== undefined && { size: item.size }),
          score: image.score === undefined ? undefined : formatScore(image.score),
          issues: image.issues,
          verdict,
          actions: (
            <ImageChoices
              jobId={item.jobId}
              iteration={item.iteration}
              index={image.index}
              verdict={verdict}
              stopped={stopped}
              chosen={chosenImages.has(`${item.jobId}:${imageKey}`)}
            />
          ),
        };
      })}
    />
  );
}

/**
 * 止まりの行。AI の判断・上限・エラーで止まったときは、最良の画像と「この画像に決める（お気に入りにする）」を添え、人が最後に選べるようにする。
 * 人が止めた・人が選んだ止まりには添えない（人がもう会話の中で動いているため）。
 */
// 止まったジョブには採る口（adopt）が使えない（止まったら受けない約束。API は 409）ので、決めるのはお気に入りの口で行う。
// 最良はジョブの状態（carry.best）から読む: 話す役の要約と同じ出どころにするため
function JobStoppedItem({ item }: { item: Extract<ChatItem, { kind: 'job-stopped' }> }) {
  const offersChoice = item.reason.kind !== 'human' && item.reason.kind !== 'adopted';
  const { data: job } = useJob(offersChoice ? item.jobId : undefined);
  const best = offersChoice ? job?.state.carry?.best : undefined;
  return (
    <div className="space-y-2">
      <StopNotice
        tone={
          item.reason.kind === 'error' ? 'error' : item.reason.kind === 'human' ? 'stopped' : 'done'
        }
        action={
          <>
            {/* バックエンドに繋がらずに止まったジョブには、設定の欄への道を添える */}
            {item.reason.kind === 'error' &&
              item.reason.backendErrorKind !== undefined &&
              BACKEND_SETUP_ERRORS.has(item.reason.backendErrorKind) && (
                <SettingsLink to="backend" />
              )}
            <JobLink jobId={item.jobId} />
          </>
        }
      >
        描くのを止めた: {summarizeStopReason(item.reason)}
      </StopNotice>
      {best !== undefined && (
        <BestChoice
          jobId={item.jobId}
          iteration={best.iteration}
          index={best.imageIndex}
          score={best.score}
        />
      )}
      {offersChoice && <LearnedFromJob jobId={item.jobId} />}
    </div>
  );
}

/**
 * このジョブから覚えたこと（蒸留が足した・直した記憶、できなかった理由）。蒸留は止まったあと裏で走るので、
 * 済むまでは「整理しています」と出し、読み直しは回数に上限を置く（useJobDistill）。
 * 人が止めた・人が選んだ止まりには出さない（呼び手が出し分ける）
 */
function LearnedFromJob({ jobId }: { jobId: string }) {
  const { data, error, pending, exhausted } = useJobDistill(jobId);
  const entries = data?.entries ?? [];
  const learned = entries.flatMap((entry) => [
    ...entry.added.map((item) => ({
      key: `add-${entry.at}-${item.id}`,
      text: `覚えた: ${item.body}`,
    })),
    ...entry.edited.map((item) => ({
      key: `edit-${entry.at}-${item.id}`,
      text: `直した: ${item.before} → ${item.after}`,
    })),
    ...(entry.failure === undefined
      ? []
      : [{ key: `failure-${entry.at}`, text: `整理できなかった: ${entry.failure}` }]),
  ]);
  return (
    <section
      aria-label="このジョブから覚えたこと"
      className="max-w-[85%] space-y-1 rounded-md border border-border px-3 py-2 text-xs"
    >
      <p className="font-medium">このジョブから覚えたこと</p>
      {error !== undefined ? (
        <p className="text-destructive">覚えたことを読めない: {error.message}</p>
      ) : data === undefined || pending ? (
        <p className="text-muted-foreground">覚えたことを整理しています</p>
      ) : exhausted ? (
        <p className="text-muted-foreground">
          覚えたことは、まだ出ていない。あとで
          <Link to="/memory" className="text-primary underline-offset-4 hover:underline">
            記憶
          </Link>
          で確かめられる。
        </p>
      ) : learned.length === 0 ? (
        <p className="text-muted-foreground">新しく覚えたことは無い。</p>
      ) : (
        <BulletList className="text-xs">
          {learned.map((item) => (
            <li key={item.key} className="break-words">
              {item.text}
            </li>
          ))}
        </BulletList>
      )}
    </section>
  );
}

function BestChoice({
  jobId,
  iteration,
  index,
  score,
}: {
  jobId: string;
  iteration: number;
  index: number;
  score: number;
}) {
  const { data } = useSelections(jobId);
  const imageKey = formatImageKey({ iteration, index });
  const verdict =
    data?.selections.find((selection) => selection.imageKey === imageKey)?.verdict ?? null;
  // 1 から数える: 画像の行（「N 回目の画像 M 番」）と同じ呼び方にするため
  const imageLabel = `${iteration} 回目の画像 ${index + 1} 番`;
  const urls = jobImageUrls(jobId, iteration, index);
  return (
    <section
      aria-label={`最良の画像: ${imageLabel}`}
      className="flex max-w-[85%] flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2 text-sm"
    >
      <img
        src={urls.previewUrl}
        alt={`最良: ${imageLabel}`}
        className="size-24 shrink-0 rounded-md object-cover"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words">
          最良: {imageLabel}（見る役の点 {formatScore(score)}）
        </p>
        <ChooseAsFavorite
          jobId={jobId}
          imageKey={imageKey}
          imageLabel={imageLabel}
          verdict={verdict}
        />
        <p className="text-xs text-muted-foreground">続けるなら、話しかけて指示を出す。</p>
      </div>
    </section>
  );
}

function AdoptedItem({ item }: { item: Extract<ChatItem, { kind: 'adopted' }> }) {
  // 選ぶとき、話す役はその画像をお気に入りにもする（adopt_image）。画像の行は選択を読んだ時点のままなので、読み直させる
  // （読み直さないと、再読み込みするまで「お気に入り」のボタンが選ぶ前のまま残る）
  const { mutate } = useSelections(item.jobId);
  useEffect(() => {
    void mutate?.();
  }, [mutate]);
  return (
    <JudgeNote
      iteration={item.iteration}
      canStop={false}
      adopted={{ iteration: item.image.iteration, number: item.image.index + 1 }}
    />
  );
}

function describeInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return String(input);
  const parts = Object.entries(input as Record<string, unknown>).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return parts.length === 0 ? undefined : parts.join(' / ');
}

function describeParams(params: Record<string, unknown>): string[] {
  return Object.entries(params).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

/**
 * 画面の外の行を置いておく背の見積もり（px。狭い画面 / 広い画面）。390px と 1280px の幅で、長い会話の行を種類ごとに測った値から決めた
 * （人の発言は中央値、画像のカードは画像4枚、AI の返答は「背 ≈ 55 + 0.46 × 字数」の当てはめ）。
 * 一度描いた行は実際の背を覚えて使うので、見積もりが効くのは、まだ一度も画面に入っていない行だけ。
 */
function rowEstimate(item: ChatItem): { estimate: number; wideEstimate: number } {
  switch (item.kind) {
    case 'user':
      return { estimate: 82, wideEstimate: 59 };
    case 'assistant': {
      const height = 55 + 0.46 * item.text.length;
      return { estimate: height, wideEstimate: height };
    }
    case 'reasoning':
      return { estimate: 40, wideEstimate: 40 };
    case 'images':
      return { estimate: 1940, wideEstimate: 770 };
    default:
      return { estimate: 100, wideEstimate: 100 };
  }
}

/** 会話の中で画像を見分ける key（ジョブが違えば同じ回・番でも別の画像） */
const viewerKeyOf = (jobId: string, imageKey: string) => `${jobId}:${imageKey}`;

type ViewerSource = { jobId: string; iteration: number; image: ChatImage };

/** 会話に出た画像を、出た順（回の順・番の順）に並べる。大きく見る窓の送りはこの順に進む */
function viewerImagesOf(items: readonly ChatItem[]): (ViewerImage & { source: ViewerSource })[] {
  return items.flatMap((item) =>
    item.kind !== 'images'
      ? []
      : item.images.map((image) => {
          const urls = jobImageUrls(item.jobId, item.iteration, image.index);
          const title = `${item.iteration} 回目の画像 ${image.index + 1} 番`;
          return {
            key: viewerKeyOf(
              item.jobId,
              formatImageKey({ iteration: item.iteration, index: image.index }),
            ),
            src: urls.url,
            fullSrc: urls.url,
            title,
            alt: `${title}（seed ${image.seed ?? '不明'}）`,
            source: { jobId: item.jobId, iteration: item.iteration, image },
          };
        }),
  );
}

function renderItem(
  item: ChatItem,
  resend: { onResend: (text: string) => void; disabled: boolean },
  /** 止まったジョブ。その画像は「採る」を押せない */
  stoppedJobs: ReadonlySet<string>,
  /** 人が選んだ画像（<jobId>:<回>-<画像>） */
  chosenImages: ReadonlySet<string>,
  /** 画像を大きく見る窓で開く */
  open: (viewerKey: string) => void,
): ReactNode {
  switch (item.kind) {
    case 'user':
      return (
        <MessageRow
          key={item.key}
          author="human"
          meta={
            item.turnInterrupted === undefined
              ? new Date(item.at).toLocaleTimeString('ja-JP', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : item.turnInterrupted
          }
          action={
            item.turnInterrupted === undefined || item.resent === true ? undefined : (
              <Button
                className="h-6 px-2 text-xs"
                disabled={resend.disabled}
                onClick={() => resend.onResend(item.text)}
              >
                送り直す
              </Button>
            )
          }
        >
          {item.attachments === 0 ? (
            item.text
          ) : (
            <>
              {item.text}
              <span className="mt-1 block text-xs opacity-80">
                画像を {item.attachments} 枚添えた
              </span>
            </>
          )}
        </MessageRow>
      );
    case 'assistant':
      return (
        <MessageRow
          key={item.key}
          author="ai"
          streaming={item.streaming}
          truncated={item.interrupted}
        >
          {item.text}
        </MessageRow>
      );
    case 'reasoning':
      return (
        <ReasoningBlock key={item.key} label={item.label} streaming={item.streaming}>
          {item.text}
        </ReasoningBlock>
      );
    case 'tool':
      return (
        <ToolCallCard
          key={item.key}
          name={item.name}
          args={describeInput(item.input)}
          state={item.state}
          result={item.summary}
        />
      );
    case 'turn-error':
      return (
        <StopNotice
          key={item.key}
          tone="error"
          // LLM が未設定で閉じたターンには、設定の欄への道を添える
          action={item.reason === LLM_NOT_CONFIGURED_REASON ? <SettingsLink to="llm" /> : undefined}
        >
          応答が失敗した{item.reason === undefined ? '' : `: ${item.reason}`}
        </StopNotice>
      );
    case 'job-started':
      return (
        <JobStartCard
          key={item.key}
          request={item.request}
          conditions={describeStopConditions(item.stopConditions)}
          link={<JobLink jobId={item.jobId} />}
        />
      );
    case 'think':
      return (
        <ThinkNote
          key={item.key}
          iteration={item.iteration}
          rationale={item.rationale}
          changes={describeParams(item.params)}
        />
      );
    case 'images':
      return (
        <ImagesItem
          key={item.key}
          item={item}
          stopped={stoppedJobs.has(item.jobId)}
          chosenImages={chosenImages}
          open={open}
        />
      );
    case 'judge':
      return (
        <JudgeNote
          key={item.key}
          iteration={item.iteration}
          canStop={item.canStop}
          nextChange={item.nextChange}
        />
      );
    case 'adopted':
      return <AdoptedItem key={item.key} item={item} />;
    case 'job-stopped':
      return <JobStoppedItem key={item.key} item={item} />;
    case 'progress':
      return (
        <GenerationProgress
          key={item.key}
          iteration={item.iteration}
          progress={item.progress}
          step={item.step}
          steps={item.steps}
          etaMs={item.etaMs}
          previewSrc={
            item.previewUrl === undefined
              ? undefined
              : // 進みごとに URL を変える: 途中の画像の URL はジョブごとに1つで、同じ src のままではブラウザが取り直さないため
                `${item.previewUrl}?progress=${item.step ?? Math.round(item.progress * 100)}`
          }
          // 生成中の回はまだ採れない: 採れるのはできあがった画像だけ（JobRunner.adopt）
          hint="できあがったら、画像の行で「この画像で決める」を選べます"
        />
      );
    case 'status':
      return <StatusLine key={item.key} status={item.status} />;
    case 'held':
      return <StatusLine key={item.key} status="job.held" />;
  }
}

function newClientMessageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ConversationView({
  conversationId,
  source,
  actions,
  title,
}: {
  conversationId: string;
  source: ConversationSource;
  actions: ConversationActions;
  title?: ReactNode;
}) {
  const { chat, loaded, error } = useConversationStream(conversationId, source);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();
  const [attached, setAttached] = useState<PendingAttachment[]>([]);
  const [refusals, setRefusals] = useState<string[]>([]);
  const nextAttachmentId = useRef(0);
  // 画面を離れるときに、残っている縮小版を片付ける
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  useEffect(() => () => attachedRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);
  // 会話が変わったときだけ作り直す: 入力欄に1文字打つたびに数千行を組み直すと、長い会話で打鍵が重くなるため
  const items = useMemo(() => chatItems(chat), [chat]);
  const running = useMemo(() => isRunning(chat), [chat]);

  function attach(files: File[]) {
    const accepted: PendingAttachment[] = [];
    const reasons: string[] = [];
    for (const file of files) {
      const problem = referenceFileProblem(file, attached.length + accepted.length);
      if (problem === undefined) {
        accepted.push({
          id: `attachment-${nextAttachmentId.current++}`,
          file,
          url: URL.createObjectURL(file),
        });
      } else {
        reasons.push(problem);
      }
    }
    setRefusals(reasons);
    if (accepted.length > 0) setAttached((current) => [...current, ...accepted]);
  }

  function removeAttachment(id: string) {
    setRefusals([]);
    setAttached((current) => {
      current.filter((item) => item.id === id).forEach((item) => URL.revokeObjectURL(item.url));
      return current.filter((item) => item.id !== id);
    });
  }

  // 添えた画像は、発言の前に1枚ずつ会話へ送り込み、その ID を発言に載せる（送り直す発言には載せない）
  async function send(text: string, withAttachments: readonly PendingAttachment[] = attached) {
    setSending(true);
    setSendError(undefined);
    try {
      const uploadIds: { uploadId: string }[] = [];
      for (const item of withAttachments) {
        if (actions.upload === undefined) break;
        const built = await buildReferenceUpload({ file: item.file, note: '' });
        if (!built.ok) throw new Error(built.reason);
        uploadIds.push({ uploadId: await actions.upload(built.value) });
      }
      await actions.send(text, newClientMessageId(), uploadIds);
      setDraft((current) => (current === text ? '' : current));
      if (withAttachments.length > 0) {
        withAttachments.forEach((item) => URL.revokeObjectURL(item.url));
        setAttached((current) => current.filter((item) => !withAttachments.includes(item)));
      }
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    setSendError(undefined);
    try {
      await actions.stop();
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // 行に渡す「送り直す」は変わらない関数にする: 変わると、下書きのたびに全部の行を作り直すことになるため
  const sendRef = useRef(send);
  sendRef.current = send;
  const resend = useCallback((text: string) => void sendRef.current(text, []), []);
  const stoppedJobs = useMemo(
    () => new Set(items.flatMap((item) => (item.kind === 'job-stopped' ? [item.jobId] : []))),
    [items],
  );
  useRecheckBackendOnFailure(
    items.findLast((item) => item.kind === 'job-stopped' && stoppedByBackend(item.reason))?.key,
  );
  const chosenImages = useMemo(
    () =>
      new Set(
        items.flatMap((item) =>
          item.kind === 'adopted' ? [`${item.jobId}:${formatImageKey(item.image)}`] : [],
        ),
      ),
    [items],
  );
  // 行が変わらなければ、前に作った行の要素をそのまま渡す: 同じ要素なら React はその行を描き直さない。
  // 書きかけの増分のたびに、確定した数千行まで描き直すと、長い会話で増分1回が重くなるため（確定した行は chatItems が同じオブジェクトで返す）。
  // ジョブが止まった・画像が選ばれたは確定したイベントで届き、そのとき確定した行は作り直される（使い回されない）ので、ここでは見なくてよい
  // 大きく見ている画像（窓の画像の key）。setViewing は変わらない関数なので、行の使い回しを崩さない
  const [viewing, setViewing] = useState<string | null>(null);
  const rowCache = useRef(new WeakMap<ChatItem, { sending: boolean; row: ReactNode }>());
  const rows = useMemo(
    () =>
      items.map((item) => {
        const cached = rowCache.current.get(item);
        if (cached !== undefined && cached.sending === sending) return cached.row;
        const row = (
          <LogRow key={item.key} {...rowEstimate(item)}>
            {renderItem(
              item,
              { onResend: resend, disabled: sending },
              stoppedJobs,
              chosenImages,
              setViewing,
            )}
          </LogRow>
        );
        rowCache.current.set(item, { sending, row });
        return row;
      }),
    [items, resend, sending, stoppedJobs, chosenImages],
  );

  const viewerImages = useMemo(() => viewerImagesOf(items), [items]);
  const last = items.at(-1);
  return (
    <>
      <ConversationImageViewer
        images={viewerImages}
        viewing={viewing}
        onViewingChange={setViewing}
        stoppedJobs={stoppedJobs}
        chosenImages={chosenImages}
      />
      <ChatLayout
        header={title}
        status={currentStatus(chat)}
        log={
          <ChatLog
            rowCount={items.length}
            followKey={`${items.length}:${last?.kind === 'assistant' || last?.kind === 'reasoning' ? last.text.length : ''}`}
          >
            <SetupNotice />
            {error !== undefined && <ErrorNote>会話を読めない: {error}</ErrorNote>}
            {loaded && items.length === 0 && (
              <Muted className="py-12 text-center">
                描いてほしいものや、聞きたいことを書いてください。
              </Muted>
            )}
            {rows}
          </ChatLog>
        }
        composer={
          <ChatComposer
            value={draft}
            onChange={setDraft}
            onSend={() => void send(draft)}
            onStop={() => void stop()}
            running={running}
            sending={sending}
            notice={
              sendError === undefined && refusals.length === 0 ? undefined : (
                <>
                  {refusals.map((reason) => (
                    <ErrorNote key={reason}>添えられない: {reason}</ErrorNote>
                  ))}
                  {sendError !== undefined && <ErrorNote>送れない: {sendError}</ErrorNote>}
                </>
              )
            }
            {...(actions.upload !== undefined && {
              attachments: attached.map((item) => ({
                id: item.id,
                name: item.file.name,
                url: item.url,
              })),
              onAttach: attach,
              onRemoveAttachment: removeAttachment,
            })}
          />
        }
      />
    </>
  );
}
