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
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { chatItems, isRunning, type ChatImage, type ChatItem } from '../lib/chat-state';
import { useConversationStream, type ConversationSource } from '../lib/conversation-stream';
import { formatScore } from '../lib/format';
import { describeStopConditions } from '../lib/stop-conditions-form';
import { summarizeStopReason } from '../lib/stop-reason';

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
  verdict,
}: {
  jobId: string;
  imageKey: string;
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
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button
          className={small}
          disabled={pending}
          aria-pressed={verdict === 'favorite'}
          onClick={() => void choose(verdict === 'favorite' ? null : 'favorite')}
        >
          {verdict === 'favorite' ? 'お気に入りを外す' : 'お気に入り'}
        </Button>
        <Button
          className={small}
          disabled={pending}
          aria-pressed={verdict === 'rejected'}
          onClick={() => void choose(verdict === 'rejected' ? null : 'rejected')}
        >
          {verdict === 'rejected' ? '却下を外す' : '却下'}
        </Button>
      </div>
      {error !== undefined && <p className="text-xs text-destructive">選べない: {error}</p>}
    </div>
  );
}

function ImagesItem({ item }: { item: Extract<ChatItem, { kind: 'images' }> }) {
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
        return {
          key: imageKey,
          href: urls.url,
          src: urls.previewUrl,
          alt: `${item.iteration} 回目の画像 ${image.index}（seed ${image.seed ?? '不明'}）`,
          score: image.score === undefined ? undefined : formatScore(image.score),
          issues: image.issues,
          verdict,
          actions: <VerdictButtons jobId={item.jobId} imageKey={imageKey} verdict={verdict} />,
        };
      })}
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

function renderItem(item: ChatItem, onResend: (text: string) => void): ReactNode {
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
            item.turnInterrupted === undefined ? undefined : (
              <Button className="h-6 px-2 text-xs" onClick={() => onResend(item.text)}>
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
      return <ImagesItem key={item.key} item={item} />;
    case 'judge':
      return (
        <JudgeNote
          key={item.key}
          iteration={item.iteration}
          canStop={item.canStop}
          nextChange={item.nextChange}
        />
      );
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
        />
      );
    case 'status':
      return <StatusLine key={item.key} status={item.status} />;
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
  const items = chatItems(chat);
  const running = isRunning(chat);

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

  const last = items.at(-1);
  return (
    <ChatLayout
      header={title}
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
          {items.map((item) => renderItem(item, (text) => void send(text)))}
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
