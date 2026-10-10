import {
  formatImageKey,
  LLM_CALL_FAILED_PREFIX,
  LLM_NOT_CONFIGURED_REASON,
  type SelectionVerdict,
} from '@drawroid/core';
import {
  conversationUploadUrl,
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
  OkNote,
  ReasoningBlock,
  StatusLine,
  StopNotice,
  ThinkNote,
  ToolCallCard,
  WarnNote,
  type ViewerImage,
} from '@drawroid/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';

import {
  chatItems,
  currentStatus,
  isRunning,
  type ChatImage,
  type ChatItem,
} from '../lib/chat-state';
import { describeBackendError } from '../lib/backend-error';
import { useConversationStream, type ConversationSource } from '../lib/conversation-stream';
import { formatScore } from '../lib/format';
import { stoppedByBackend, useRecheckBackendOnFailure } from '../lib/recheck-backend';
import { describeStopConditions } from '../lib/stop-conditions-form';
import { llmStageFailure, summarizeStopReason } from '../lib/stop-reason';
import { summarizeToolRow, toolTitle } from '../lib/tool-rows';
import { buildReferenceUpload, referenceFileProblem } from '../lib/reference-upload';
import { AdoptButton } from './adopt-button';
import { ChooseAsFavorite } from './choose-as-favorite';
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

/** ジョブを見分ける言葉に使う、依頼の文の頭の文字数 */
const JOB_NAME_CHARS = 12;

/**
 * 会話の中のジョブを見分ける言葉。依頼の文の頭（12 文字、長ければ「…」）。依頼の文が無いジョブ（手動の生成）は「手動の生成」。
 * 同じ会話に2つ以上のジョブがあると、どれも「1 回目の画像 1 番」になり、読み上げや声の操作で聞き分けられないため
 */
export function jobNameOf(request: string | undefined): string {
  const text = request?.trim() ?? '';
  if (text === '') return '手動の生成';
  return text.length > JOB_NAME_CHARS ? `${text.slice(0, JOB_NAME_CHARS)}…` : text;
}

/**
 * 会話のジョブ ID → ジョブを見分ける言葉。会話の「描き始めた」（job.started）から作る。
 * 同じ言葉のジョブ（同じ依頼で描き直したなど）は、2つ目から「（2）」「（3）」を添えて別の名前にする
 */
function jobNamesOf(items: readonly ChatItem[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const used = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== 'job-started' || names.has(item.jobId)) continue;
    const name = jobNameOf(item.request);
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    names.set(item.jobId, count === 1 ? name : `${name}（${count}）`);
  }
  return names;
}

const JobNames = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * 画像の呼び方（「猫を描いて 1 回目の画像 1 番」）。回も枚も 1 から数える（人が選んだ回の表示と同じ）。
 * 会話に描き始めた記録が無いジョブ（読み込みの途中など）は、ジョブの言葉を付けない
 */
function imageNameOf(jobName: string | undefined, iteration: number, index: number): string {
  return `${jobName === undefined ? '' : `${jobName} `}${iteration} 回目の画像 ${index + 1} 番`;
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

/** 読み上げの名前に、どのジョブの（画像の行なら、何回目の）詳細かを添える */
// 添える: 会話にはジョブの行と画像の行ごとにこのリンクが並び、どれも同じ「ジョブの詳細」と読まれて区別できないため
function JobLink({ jobId, iteration }: { jobId: string; iteration?: number }) {
  const name = useContext(JobNames).get(jobId);
  const which = [name, iteration === undefined ? undefined : `${iteration} 回目`]
    .filter((part) => part !== undefined)
    .join(' ');
  return (
    <Link
      to={`/jobs/${jobId}`}
      {...(which !== '' && { 'aria-label': `ジョブの詳細: ${which}` })}
      className="text-xs text-primary underline-offset-4 hover:underline"
    >
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
  const favorite = verdict === 'favorite' ? 'お気に入りを外す' : 'お気に入り';
  const reject = verdict === 'rejected' ? '却下を外す' : '却下';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {/* 読み上げの名前は見える文言で始める: 声で操作する人が、見えている文言で呼べるように */}
        <Button
          size="sm"
          disabled={pending}
          aria-pressed={verdict === 'favorite'}
          aria-label={`${favorite}: ${imageLabel}`}
          onClick={() => void choose(verdict === 'favorite' ? null : 'favorite')}
        >
          {favorite}
        </Button>
        <Button
          size="sm"
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

/** 1枚の画像への選び方（お気に入り・却下と「この画像に決める」）。画像の行と、大きく見る窓の両方に置く（同じ口を呼ぶ） */
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
  const imageLabel = imageNameOf(useContext(JobNames).get(jobId), iteration, index);
  // この行で決めたか。決めるとジョブは止まり、止まった知らせが決めた知らせ（chosen）より先に届くことがある。
  // その間に「止まった・決めていない」の形（お気に入りのボタン）へ差し替えると、決めた印が作り直され、印へ移したフォーカスが落ちるため
  const [decidedHere, setDecidedHere] = useState(false);
  const [confirmingHere, setConfirmingHere] = useState(false);
  return (
    <div className="space-y-1">
      <VerdictButtons jobId={jobId} imageKey={imageKey} imageLabel={imageLabel} verdict={verdict} />
      {/* 止まったジョブは採る口を受けない（止まったら受けない約束。API は 409）ので、止まりのカードと同じく、決めるのはお気に入りにする。
          人が選んで止まった画像は、選んだと出す */}
      {stopped && !chosen && !decidedHere ? (
        <ChooseAsFavorite
          jobId={jobId}
          imageKey={imageKey}
          imageLabel={imageLabel}
          verdict={verdict}
          interrupted={confirmingHere}
        />
      ) : (
        <AdoptButton
          jobId={jobId}
          image={{ iteration, index }}
          imageLabel={imageLabel}
          chosen={chosen}
          onDecided={() => setDecidedHere(true)}
          onConfirmingChange={setConfirmingHere}
        />
      )}
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
        <Button size="sm" onClick={onPaint}>
          マスクを塗る
        </Button>
      )}
    </div>
  );
}

const PAINTING_LOCK = '塗っている間は前後へ送れない。';
const PAINTING_HOLD =
  '塗りかけがある間は、Esc や窓の外を押しても閉じない（閉じるボタンは、塗りかけを捨てて閉じる）。';
const MASK_SENT = 'マスクを送った。次の回で描き直す。';

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
  /** source が無いのは、人が会話で添えた画像（塗ることも選ぶこともできない） */
  images: readonly (ViewerImage & { source?: ViewerSource })[];
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
      : images.find(
          (image): image is ViewerImage & { source: ViewerSource } =>
            image.key === paintingKey && image.source !== undefined,
        );
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
  // 送ったら、塗る形を閉じて見る形に戻す（前後へ送れ、Esc で閉じる）。送ったことは、その画像の下に短く出す
  const [sentKey, setSentKey] = useState<string | null>(null);
  useEffect(() => {
    if (!painting.sent || paintingKey === null) return;
    setSentKey(paintingKey);
    setPaintingKey(null);
  }, [painting.sent, paintingKey]);
  return (
    <ImageViewer
      images={images}
      openKey={viewing}
      onOpenKeyChange={(key) => {
        setPaintingKey(null);
        setSentKey(null);
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
          <div className="space-y-2">
            {sentKey === image.key && <OkNote>{MASK_SENT}</OkNote>}
            <ViewerImageDetails
              {...source}
              stopped={stopped}
              chosen={chosenImages.has(`${source.jobId}:${imageKey}`)}
              {...(!stopped && {
                onPaint: () => {
                  setSentKey(null);
                  setPaintingKey(image.key);
                },
              })}
            />
          </div>
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
  const jobName = useContext(JobNames).get(item.jobId);
  const verdicts = new Map(
    (data?.selections ?? []).flatMap(({ imageKey, verdict }) =>
      verdict === null ? [] : [[imageKey, verdict] as const],
    ),
  );
  return (
    <ImageRow
      iteration={item.iteration}
      link={<JobLink jobId={item.jobId} iteration={item.iteration} />}
      images={item.images.map((image: ChatImage) => {
        const imageKey = formatImageKey({ iteration: item.iteration, index: image.index });
        const urls = jobImageUrls(item.jobId, item.iteration, image.index);
        const verdict = verdicts.get(imageKey) ?? null;
        const imageLabel = imageNameOf(jobName, item.iteration, image.index);
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
 * 止まりの行。人が画像を選んで止めたとき以外は、最良の画像と「この画像に決める（お気に入りにする）」を添え、人が最後に選べるようにする。
 * 人が止めたときも添える（止めたあと、途中の画像から選べるように）。人が選んだ止まりには添えない（もう選んである）。
 * 覚えたことは、AI の判断・上限・エラーで止まったときだけ添える。
 */
// 止まったジョブには採る口（adopt）が使えない（止まったら受けない約束。API は 409）ので、決めるのはお気に入りの口で行う。
// 最良はジョブの状態（carry.best）から読む: 話す役の要約と同じ出どころにするため
function JobStoppedItem({ item }: { item: Extract<ChatItem, { kind: 'job-stopped' }> }) {
  const offersChoice = item.reason.kind !== 'adopted';
  const showsLearned = offersChoice && item.reason.kind !== 'human';
  const { data: job } = useJob(offersChoice ? item.jobId : undefined);
  const best = offersChoice ? job?.state.carry?.best : undefined;
  const backendAction =
    item.reason.kind === 'error' && item.reason.backendErrorKind !== undefined
      ? describeBackendError(item.reason.backendErrorKind)?.action
      : undefined;
  return (
    <div className="space-y-2">
      <StopNotice
        tone={
          item.reason.kind === 'error' ? 'error' : item.reason.kind === 'human' ? 'stopped' : 'done'
        }
        action={
          <>
            {/* LLM の役が失敗して止まったジョブには、LLM の設定の欄への道を添える */}
            {llmStageFailure(item.reason) !== undefined && <SettingsLink to="llm" />}
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
        {/* バックエンドの失敗には、次に何をするかも添える（ジョブの詳細を開かなくても分かるように） */}
        {backendAction}
      </StopNotice>
      {best !== undefined && (
        <BestChoice
          jobId={item.jobId}
          iteration={best.iteration}
          index={best.imageIndex}
          score={best.score}
        />
      )}
      {showsLearned && <LearnedFromJob jobId={item.jobId} />}
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
      ) : data === undefined || (entries.length === 0 && pending) ? (
        <p className="text-muted-foreground">覚えたことを整理しています</p>
      ) : entries.length === 0 && exhausted ? (
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
      {/* 選び直したあと（記録がすでにある）: 増えるまでの間と、増えずに読み直しが尽きたとき */}
      {entries.length > 0 && pending && (
        <p className="text-muted-foreground">選び直したことを整理しています</p>
      )}
      {entries.length > 0 && exhausted && (
        <p className="text-muted-foreground">
          選び直したことは、まだ出ていない。あとで
          <Link to="/memory" className="text-primary underline-offset-4 hover:underline">
            記憶
          </Link>
          で確かめられる。
        </p>
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
  // 画像の行と同じ呼び方にする
  const imageLabel = imageNameOf(useContext(JobNames).get(jobId), iteration, index);
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
          prominent
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

/**
 * ツールの行。見出しは人の言葉の呼び方、本文は結果の短い要約にする。ツールの名前・生の引数・結果の全文は「詳しく」に畳んで残す:
 * 生の JSON や作り手向けの断りの文を、人が会話の中で読まなくて済むように
 */
function ToolRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const title = toolTitle(item.name);
  const short = summarizeToolRow(item.name, item.state, item.summary);
  const args = describeInput(item.input);
  return (
    <ToolCallCard
      name={item.name}
      {...(title !== undefined && { title })}
      state={item.state}
      result={short}
      details={
        <>
          <div>
            ツール: <code>{item.name}</code>
          </div>
          {args !== undefined && (
            <div className="font-mono break-all text-muted-foreground">{args}</div>
          )}
          {item.summary !== undefined && item.summary !== short && (
            <div className="break-words whitespace-pre-wrap">{item.summary}</div>
          )}
        </>
      }
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

/** 人の発言に添えた画像を、大きく見る窓の1枚にする（窓の中に評価や選ぶボタンは出さない） */
function attachedViewerImage(
  conversationId: string,
  message: Extract<ChatItem, { kind: 'user' }>,
  uploadId: string,
  index: number,
): ViewerImage {
  const url = conversationUploadUrl(conversationId, uploadId);
  // 発言の頭を添える: 読み上げで、どの発言に添えた画像かを、ほかの発言のものと聞き分けられるように
  const said = message.text.length > 12 ? `${message.text.slice(0, 12)}…` : message.text;
  const title = `添えた画像 ${index + 1} 枚目`;
  return {
    key: `upload:${uploadId}`,
    src: url,
    fullSrc: url,
    title,
    alt: said === '' ? title : `${title}（「${said}」）`,
  };
}

/** 会話に出た画像を、出た順（回の順・番の順）に並べる。大きく見る窓の送りはこの順に進む */
function viewerImagesOf(
  items: readonly ChatItem[],
  conversationId: string,
): (ViewerImage & { source?: ViewerSource })[] {
  const jobNames = jobNamesOf(items);
  return items.flatMap((item) =>
    item.kind === 'user'
      ? item.attachments.map((uploadId, index) =>
          attachedViewerImage(conversationId, item, uploadId, index),
        )
      : item.kind !== 'images'
        ? []
        : item.images.map((image) => {
            const urls = jobImageUrls(item.jobId, item.iteration, image.index);
            const title = imageNameOf(jobNames.get(item.jobId), item.iteration, image.index);
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
  conversationId: string,
  resend: { onResend: (text: string) => void; disabled: boolean },
  /** 止まったジョブ。その画像は「採る」を押せない */
  stoppedJobs: ReadonlySet<string>,
  /** 人が選んだ画像（<jobId>:<回>-<画像>） */
  chosenImages: ReadonlySet<string>,
  /** 画像を大きく見る窓で開く */
  open: (viewerKey: string) => void,
  /** drawroid につながっていない（進み具合のカードが止まって見える） */
  disconnected: boolean,
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
          {item.attachments.length === 0 ? (
            item.text
          ) : (
            <>
              {item.text}
              <ul
                aria-label={`添えた画像（${item.attachments.length} 枚）`}
                className="mt-2 flex flex-wrap gap-2"
              >
                {item.attachments.map((uploadId, index) => {
                  const image = attachedViewerImage(conversationId, item, uploadId, index);
                  return (
                    <li key={uploadId}>
                      {/* 縮小版は決まった大きさの枡に収める: 読み込む前から背を取り、上の行の読み込みで下が押し下げられないように */}
                      <button
                        type="button"
                        data-viewer-key={image.key}
                        aria-label={`大きく見る: ${image.alt}`}
                        onClick={() => open(image.key)}
                        className="block size-16 cursor-zoom-in overflow-hidden rounded-md bg-muted"
                      >
                        <img src={image.src} alt={image.alt} className="size-full object-cover" />
                      </button>
                    </li>
                  );
                })}
              </ul>
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
      return <ToolRow key={item.key} item={item} />;
    case 'turn-error':
      return (
        <StopNotice
          key={item.key}
          tone="error"
          // LLM が未設定のとき・LLM の呼び出しが失敗したときに閉じたターンには、設定の欄への道を添える
          action={
            item.reason === LLM_NOT_CONFIGURED_REASON ||
            item.reason?.startsWith(LLM_CALL_FAILED_PREFIX) === true ? (
              <SettingsLink to="llm" />
            ) : undefined
          }
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
          hint="できあがったら、画像の行の「この画像に決める」で選べる"
          stalled={disconnected}
        />
      );
    case 'status':
      return <StatusLine key={item.key} status={item.status} />;
    case 'held':
      return <StatusLine key={item.key} status="job.held" />;
  }
}

/** 行の外にあって、その行の描き方を変えるもの（画像の行なら、ジョブが止まったかと、選ばれた画像）。同じなら描き直さなくてよい */
function outsideOfRow(
  item: ChatItem,
  stoppedJobs: ReadonlySet<string>,
  chosenImages: ReadonlySet<string>,
): string {
  if (item.kind !== 'images') return '';
  const chosen = [...chosenImages].filter((key) => key.startsWith(`${item.jobId}:`));
  return `${stoppedJobs.has(item.jobId)}|${chosen.join(',')}`;
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
  focusComposer = false,
}: {
  conversationId: string;
  source: ConversationSource;
  actions: ConversationActions;
  title?: ReactNode;
  /** 話しかける欄へフォーカスを移して始める（新しい会話を始めたとき） */
  focusComposer?: boolean;
}) {
  const { chat, loaded, error, disconnected } = useConversationStream(conversationId, source);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();
  const [stopError, setStopError] = useState<string | undefined>();
  // つながり直したら、切れている間の「送れない」「止められない」は消す: 残ると、直ったあとも効かないように見えるため
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (wasDisconnected.current && !disconnected) {
      setSendError(undefined);
      setStopError(undefined);
    }
    wasDisconnected.current = disconnected;
  }, [disconnected]);
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
    setStopError(undefined);
    try {
      await actions.stop();
    } catch (caught) {
      setStopError(caught instanceof Error ? caught.message : String(caught));
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
  // 書きかけの増分や、走っているジョブの段が確定するたびに、確定した数千行まで描き直すと、長い会話で1回が重くなるため
  // （中身の変わらない確定した行は chatItems が同じオブジェクトで返す）。
  // 画像の行は、ジョブが止まった・画像が選ばれたでも描き直す: 行そのものは変わらず同じオブジェクトのまま届くため
  // 大きく見ている画像（窓の画像の key）。setViewing は変わらない関数なので、行の使い回しを崩さない
  const [viewing, setViewing] = useState<string | null>(null);
  const rowCache = useRef(
    new WeakMap<
      ChatItem,
      { sending: boolean; disconnected: boolean; outside: string; row: ReactNode }
    >(),
  );
  const rows = useMemo(
    () =>
      items.map((item) => {
        const cached = rowCache.current.get(item);
        const outside = outsideOfRow(item, stoppedJobs, chosenImages);
        // つながりで変わるのは進み具合のカードだけ: 切れた・戻ったで、確定した数千行まで描き直さないため
        if (
          cached !== undefined &&
          cached.sending === sending &&
          cached.outside === outside &&
          (item.kind !== 'progress' || cached.disconnected === disconnected)
        )
          return cached.row;
        const row = (
          <LogRow key={item.key} {...rowEstimate(item)}>
            {renderItem(
              item,
              conversationId,
              { onResend: resend, disabled: sending },
              stoppedJobs,
              chosenImages,
              setViewing,
              disconnected,
            )}
          </LogRow>
        );
        rowCache.current.set(item, { sending, disconnected, outside, row });
        return row;
      }),
    [items, conversationId, resend, sending, stoppedJobs, chosenImages, disconnected],
  );

  const viewerImages = useMemo(
    () => viewerImagesOf(items, conversationId),
    [items, conversationId],
  );
  const last = items.at(-1);
  // 名前の中身が変わったときだけ作り直す: 返答の増分のたびに作り直すと、確定した画像の行まで描き直すことになるため
  const jobNamesKey = JSON.stringify([...jobNamesOf(items)]);
  const jobNames = useMemo(
    () => new Map(JSON.parse(jobNamesKey) as [string, string][]),
    [jobNamesKey],
  );
  return (
    <JobNames.Provider value={jobNames}>
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
                描いてほしいものや、聞きたいことを話しかける。
              </Muted>
            )}
            {rows}
          </ChatLog>
        }
        composer={
          <ChatComposer
            focusOnMount={focusComposer}
            value={draft}
            onChange={setDraft}
            onSend={() => void send(draft)}
            onStop={() => void stop()}
            running={running}
            sending={sending}
            notice={
              !disconnected &&
              sendError === undefined &&
              stopError === undefined &&
              refusals.length === 0 ? undefined : (
                <>
                  {disconnected && (
                    <WarnNote>drawroid につながっていない。つながり直すのを待っている</WarnNote>
                  )}
                  {refusals.map((reason) => (
                    <ErrorNote key={reason}>添えられない: {reason}</ErrorNote>
                  ))}
                  {sendError !== undefined && <ErrorNote>送れない: {sendError}</ErrorNote>}
                  {stopError !== undefined && <ErrorNote>止められない: {stopError}</ErrorNote>}
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
    </JobNames.Provider>
  );
}
