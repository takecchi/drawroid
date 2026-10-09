import { formatImageKey, type SelectionVerdict } from '@drawroid/core';
import { isApiError, jobImageUrls, setSelection, useSelections } from '@drawroid/swr';
import {
  Button,
  ChatComposer,
  ChatLayout,
  ChatLog,
  ErrorNote,
  GenerationProgress,
  ImageRow,
  JobStartCard,
  JudgeNote,
  MessageRow,
  Muted,
  ReasoningBlock,
  StatusLine,
  StopNotice,
  ThinkNote,
  ToolCallCard,
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
import { describeStopConditions } from '../lib/stop-conditions-form';
import { summarizeStopReason } from '../lib/stop-reason';
import { AdoptButton } from './adopt-button';

/** 発言と止めるの送り先。どちらも HTTP API（会話 C）に乗る。画面にだけある経路は作らない */
export interface ConversationActions {
  send(text: string, clientMessageId: string): Promise<void>;
  stop(): Promise<void>;
}

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

function ImagesItem({
  item,
  stopped,
  chosenImages,
}: {
  item: Extract<ChatItem, { kind: 'images' }>;
  /** ジョブが止まった。採る（この画像で決める）は押せない */
  stopped: boolean;
  /** 人が選んだ画像（<jobId>:<回>-<画像>） */
  chosenImages: ReadonlySet<string>;
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
        return {
          key: imageKey,
          href: urls.url,
          src: urls.previewUrl,
          alt: `${imageLabel}（seed ${image.seed ?? '不明'}）`,
          score: image.score === undefined ? undefined : formatScore(image.score),
          issues: image.issues,
          verdict,
          actions: (
            <div className="space-y-1">
              <VerdictButtons
                jobId={item.jobId}
                imageKey={imageKey}
                imageLabel={imageLabel}
                verdict={verdict}
              />
              <AdoptButton
                jobId={item.jobId}
                image={{ iteration: item.iteration, index: image.index }}
                imageLabel={imageLabel}
                chosen={chosenImages.has(`${item.jobId}:${imageKey}`)}
                {...(stopped && { disabledReason: '描くのはもう止まっているので、決められない' })}
              />
            </div>
          ),
        };
      })}
    />
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

function renderItem(
  item: ChatItem,
  resend: { onResend: (text: string) => void; disabled: boolean },
  /** 止まったジョブ。その画像は「採る」を押せない */
  stoppedJobs: ReadonlySet<string>,
  /** 人が選んだ画像（<jobId>:<回>-<画像>） */
  chosenImages: ReadonlySet<string>,
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
          {item.text}
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
        <StopNotice key={item.key} tone="error">
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
      return (
        <StopNotice
          key={item.key}
          tone={
            item.reason.kind === 'error'
              ? 'error'
              : item.reason.kind === 'human'
                ? 'stopped'
                : 'done'
          }
          action={<JobLink jobId={item.jobId} />}
        >
          描くのを止めた: {summarizeStopReason(item.reason)}
        </StopNotice>
      );
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
  // 会話が変わったときだけ作り直す: 入力欄に1文字打つたびに数千行を組み直すと、長い会話で打鍵が重くなるため
  const items = useMemo(() => chatItems(chat), [chat]);
  const running = useMemo(() => isRunning(chat), [chat]);

  async function send(text: string) {
    setSending(true);
    setSendError(undefined);
    try {
      await actions.send(text, newClientMessageId());
      setDraft((current) => (current === text ? '' : current));
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
  const resend = useCallback((text: string) => void sendRef.current(text), []);
  const stoppedJobs = useMemo(
    () => new Set(items.flatMap((item) => (item.kind === 'job-stopped' ? [item.jobId] : []))),
    [items],
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
  // 画像の行は、ジョブが止まったか・どの画像が選ばれたかでも描き方が変わるので、それも見て使い回す
  const rowCache = useRef(new WeakMap<ChatItem, { inputs: string; row: ReactNode }>());
  const rows = useMemo(
    () =>
      items.map((item) => {
        const inputs =
          item.kind === 'images'
            ? `${sending}|${stoppedJobs.has(item.jobId)}|${item.images
                .map((image) =>
                  chosenImages.has(
                    `${item.jobId}:${formatImageKey({ iteration: item.iteration, index: image.index })}`,
                  ),
                )
                .join(',')}`
            : String(sending);
        const cached = rowCache.current.get(item);
        if (cached !== undefined && cached.inputs === inputs) return cached.row;
        const row = renderItem(
          item,
          { onResend: resend, disabled: sending },
          stoppedJobs,
          chosenImages,
        );
        rowCache.current.set(item, { inputs, row });
        return row;
      }),
    [items, resend, sending, stoppedJobs, chosenImages],
  );

  const last = items.at(-1);
  return (
    <ChatLayout
      header={title}
      status={currentStatus(chat)}
      log={
        <ChatLog
          followKey={`${items.length}:${last?.kind === 'assistant' || last?.kind === 'reasoning' ? last.text.length : ''}`}
        >
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
            sendError === undefined ? undefined : <ErrorNote>送れない: {sendError}</ErrorNote>
          }
        />
      }
    />
  );
}
