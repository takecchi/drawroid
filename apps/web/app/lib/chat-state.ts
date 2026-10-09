import type { ConversationEvent, LiveEvent, StopConditions, StopReason } from '@drawroid/core';

// 会話のイベントを、ログの行の並びに畳む（設計: docs/design/conversational-agent.md の「イベント」「SSE」）。
// 確定したイベント（seq 付き）が正本で、確定しない増分は、同じ部品が確定するまでの間だけ末尾に出す。

type EventOf<T, K> = T extends { type: K } ? T : never;
type ProgressEvent = EventOf<LiveEvent, 'generation.progress'>;
type ReasoningSource = EventOf<LiveEvent, 'delta.reasoning'>['source'];
export type ChatStatus = EventOf<LiveEvent, 'status'>['status'];

export interface ChatImage {
  index: number;
  seed: number | null;
  score?: number;
  issues?: string[];
}

export type ChatItem =
  | {
      kind: 'user';
      key: string;
      seq: number;
      at: string;
      text: string;
      /** 読んだターンが途中で途切れた理由（「送り直す」を出す） */
      turnInterrupted?: string;
    }
  | {
      kind: 'assistant';
      key: string;
      text: string;
      streaming: boolean;
      interrupted: boolean;
    }
  | { kind: 'reasoning'; key: string; label: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      key: string;
      name: string;
      input: unknown;
      state: 'running' | 'ok' | 'error';
      summary?: string;
    }
  | { kind: 'turn-error'; key: string; reason?: string }
  | {
      kind: 'job-started';
      key: string;
      jobId: string;
      request: string;
      stopConditions: StopConditions;
    }
  | {
      kind: 'think';
      key: string;
      jobId: string;
      iteration: number;
      rationale: string;
      params: Record<string, unknown>;
    }
  | { kind: 'images'; key: string; jobId: string; iteration: number; images: ChatImage[] }
  | {
      kind: 'judge';
      key: string;
      jobId: string;
      iteration: number;
      canStop: boolean;
      nextChange: string;
    }
  | { kind: 'job-stopped'; key: string; jobId: string; reason: StopReason }
  | {
      kind: 'progress';
      key: string;
      jobId: string;
      iteration: number;
      progress: number;
      step?: number;
      steps?: number;
      etaMs?: number;
    }
  | { kind: 'status'; key: string; status: ChatStatus };

type ItemOf<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

interface LivePart {
  kind: 'assistant' | 'reasoning';
  source?: ReasoningSource;
  text: string;
}

export interface ChatState {
  /** seq の順。同じ seq は1度だけ */
  confirmed: ConversationEvent[];
  /** 確定していない部品（partId → 本文）。届いた順に並べる */
  live: Map<string, LivePart>;
  progress: Map<string, ProgressEvent>;
  status: ChatStatus | undefined;
}

export const EMPTY_CHAT_STATE: ChatState = {
  confirmed: [],
  live: new Map(),
  progress: new Map(),
  status: undefined,
};

export function lastSeq(state: ChatState): number {
  return state.confirmed.at(-1)?.seq ?? 0;
}

const sameJobRole = (
  source: ReasoningSource | undefined,
  role: 'think' | 'judge',
  jobId: string,
  iteration: number,
) =>
  source !== undefined &&
  source.role === role &&
  source.jobId === jobId &&
  source.iteration === iteration;

/** 確定したイベントを1件取り込む。読み直しと SSE の継ぎ目で同じ seq が二度来ても、二重にしない */
export function applyConfirmed(state: ChatState, event: ConversationEvent): ChatState {
  if (state.confirmed.some((existing) => existing.seq === event.seq)) return state;
  const confirmed = [...state.confirmed, event].sort((a, b) => a.seq - b.seq);
  const live = new Map(state.live);
  const progress = new Map(state.progress);
  let status = state.status;

  switch (event.type) {
    case 'assistant.message':
    case 'assistant.reasoning':
      live.delete(event.partId);
      if (status === 'waiting-llm') status = undefined;
      break;
    case 'tool.call':
      if (status === 'waiting-llm') status = undefined;
      break;
    case 'turn.started':
      if (status === 'queued') status = undefined;
      break;
    case 'turn.ended':
      // ターンの終わりに、そのターンの書きかけを捨てる: 確定しないまま終わった本文は、もう確定しないため
      for (const [partId, part] of live) {
        if (part.source === undefined || part.source.role === 'talk') live.delete(partId);
      }
      status = undefined;
      break;
    case 'job.think':
    case 'job.judge': {
      const role = event.type === 'job.think' ? 'think' : 'judge';
      for (const [partId, part] of live) {
        if (sameJobRole(part.source, role, event.jobId, event.iteration)) live.delete(partId);
      }
      break;
    }
    case 'job.images': {
      const running = progress.get(event.jobId);
      if (running !== undefined && running.iteration <= event.iteration)
        progress.delete(event.jobId);
      break;
    }
    case 'job.stopped':
      progress.delete(event.jobId);
      for (const [partId, part] of live) {
        if (
          part.source !== undefined &&
          'jobId' in part.source &&
          part.source.jobId === event.jobId
        ) {
          live.delete(partId);
        }
      }
      break;
    default:
      break;
  }
  return { confirmed, live, progress, status };
}

/** 確定しない増分を1件取り込む。本文と思考は継ぎ足す（増分で届くため） */
export function applyLive(state: ChatState, event: LiveEvent): ChatState {
  switch (event.type) {
    case 'delta.text':
    case 'delta.reasoning': {
      // 確定済みの部品への遅れた増分は捨てる: 継ぎ目で、確定のあとに古い増分が届くことがあるため
      const alreadyConfirmed = state.confirmed.some(
        (confirmed) =>
          (confirmed.type === 'assistant.message' || confirmed.type === 'assistant.reasoning') &&
          confirmed.partId === event.partId,
      );
      if (alreadyConfirmed) return state;
      const live = new Map(state.live);
      const current = live.get(event.partId);
      live.set(event.partId, {
        kind: event.type === 'delta.text' ? 'assistant' : 'reasoning',
        source: event.type === 'delta.reasoning' ? event.source : undefined,
        // replace は購読を始めたときの写し（ここまでの全文）。つなぎ直した画面には途中の本文が残っているので、継ぎ足すと二重になる
        text: event.replace === true ? event.text : (current?.text ?? '') + event.text,
      });
      const status = state.status === 'waiting-llm' ? undefined : state.status;
      return { ...state, live, status };
    }
    case 'generation.progress': {
      const progress = new Map(state.progress);
      progress.set(event.jobId, event);
      return { ...state, progress };
    }
    case 'status':
      return { ...state, status: event.status };
  }
}

function reasoningLabel(source: ReasoningSource | undefined): string {
  if (source === undefined || source.role === 'talk') return '思考';
  return source.role === 'think'
    ? `考える役の思考（${source.iteration} 回目）`
    : `見る役の思考（${source.iteration} 回目）`;
}

const imagesKey = (jobId: string, iteration: number) => `images:${jobId}:${iteration}`;

/** ログの行の並びを作る */
export function chatItems(state: ChatState): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ItemOf<'tool'>>();
  const images = new Map<string, ItemOf<'images'>>();
  const userByTurn = new Map<number, ItemOf<'user'>>();
  const pendingUser: ItemOf<'user'>[] = [];

  for (const event of state.confirmed) {
    const key = `seq:${event.seq}`;
    switch (event.type) {
      case 'user.message': {
        const item = { kind: 'user' as const, key, seq: event.seq, at: event.at, text: event.text };
        pendingUser.push(item);
        items.push(item);
        break;
      }
      case 'turn.started':
        for (const seq of event.messageSeqs) {
          const user = pendingUser.find((item) => item.seq === seq);
          if (user !== undefined) userByTurn.set(event.turn, user);
        }
        break;
      case 'assistant.message':
        items.push({
          kind: 'assistant',
          key: `part:${event.partId}`,
          text: event.text,
          streaming: false,
          interrupted: event.interrupted,
        });
        break;
      case 'assistant.reasoning':
        items.push({
          kind: 'reasoning',
          key: `part:${event.partId}`,
          label: '思考',
          text: event.text,
          streaming: false,
        });
        break;
      case 'tool.call': {
        const item = {
          kind: 'tool' as const,
          key: `tool:${event.callId}`,
          name: event.name,
          input: event.input,
          state: 'running' as const,
        };
        tools.set(event.callId, item);
        items.push(item);
        break;
      }
      case 'tool.result': {
        const call = tools.get(event.callId);
        if (call === undefined) break;
        const index = items.indexOf(call);
        const done = {
          ...call,
          state: event.ok ? ('ok' as const) : ('error' as const),
          summary: event.summary,
        };
        items[index] = done;
        tools.set(event.callId, done);
        break;
      }
      case 'turn.ended':
        if (event.outcome === 'error')
          items.push({ kind: 'turn-error', key, reason: event.reason });
        if (event.outcome === 'interrupted') {
          // 途中で途切れたターンは、読んだ発言に「送り直す」を出す（設計: 復帰）
          const user = userByTurn.get(event.turn);
          if (user !== undefined) {
            const index = items.indexOf(user);
            items[index] = { ...user, turnInterrupted: event.reason ?? '応答が途中で途切れた' };
          }
        }
        break;
      case 'job.started':
        items.push({
          kind: 'job-started',
          key,
          jobId: event.jobId,
          request: event.request,
          stopConditions: event.stopConditions,
        });
        break;
      case 'job.think':
        if (event.reasoning !== undefined) {
          items.push({
            kind: 'reasoning',
            key: `${key}:reasoning`,
            label: `考える役の思考（${event.iteration} 回目）`,
            text: event.reasoning,
            streaming: false,
          });
        }
        items.push({
          kind: 'think',
          key,
          jobId: event.jobId,
          iteration: event.iteration,
          rationale: event.rationale,
          params: event.params,
        });
        break;
      case 'job.images': {
        const item = {
          kind: 'images' as const,
          key: imagesKey(event.jobId, event.iteration),
          jobId: event.jobId,
          iteration: event.iteration,
          images: event.images.map(({ index, seed }) => ({ index, seed })),
        };
        images.set(item.key, item);
        items.push(item);
        break;
      }
      case 'job.judge': {
        // 評価は、同じ回の画像の行に重ねる: 画像と点数が離れて並ぶと、どの画像の点数か追いにくいため
        const shown = images.get(imagesKey(event.jobId, event.iteration));
        if (shown !== undefined) {
          const scored = {
            ...shown,
            images: shown.images.map((image) => {
              const judged = event.images.find((candidate) => candidate.index === image.index);
              return judged === undefined
                ? image
                : { ...image, score: judged.score, issues: judged.issues };
            }),
          };
          items[items.indexOf(shown)] = scored;
          images.set(scored.key, scored);
        }
        if (event.reasoning !== undefined) {
          items.push({
            kind: 'reasoning',
            key: `${key}:reasoning`,
            label: `見る役の思考（${event.iteration} 回目）`,
            text: event.reasoning,
            streaming: false,
          });
        }
        items.push({
          kind: 'judge',
          key,
          jobId: event.jobId,
          iteration: event.iteration,
          canStop: event.canStop,
          nextChange: event.nextChange,
        });
        break;
      }
      case 'job.stopped':
        items.push({ kind: 'job-stopped', key, jobId: event.jobId, reason: event.reason });
        break;
      case 'job.intervention':
        break;
    }
  }

  for (const [partId, part] of state.live) {
    items.push(
      part.kind === 'assistant'
        ? {
            kind: 'assistant',
            key: `part:${partId}`,
            text: part.text,
            streaming: true,
            interrupted: false,
          }
        : {
            kind: 'reasoning',
            key: `part:${partId}`,
            label: reasoningLabel(part.source),
            text: part.text,
            streaming: true,
          },
    );
  }
  for (const progress of state.progress.values()) {
    items.push({
      kind: 'progress',
      key: `progress:${progress.jobId}`,
      jobId: progress.jobId,
      iteration: progress.iteration,
      progress: progress.progress,
      step: progress.step,
      steps: progress.steps,
      etaMs: progress.etaMs,
    });
  }
  if (state.status !== undefined)
    items.push({ kind: 'status', key: 'status', status: state.status });
  return items;
}

/** 話す役のターンか、会話のジョブが走っているか（止めるボタンを出すか） */
export function isRunning(state: ChatState): boolean {
  let turnOpen = false;
  const jobs = new Set<string>();
  for (const event of state.confirmed) {
    if (event.type === 'turn.started') turnOpen = true;
    if (event.type === 'turn.ended') turnOpen = false;
    if (event.type === 'job.started') jobs.add(event.jobId);
    if (event.type === 'job.stopped') jobs.delete(event.jobId);
  }
  return turnOpen || jobs.size > 0 || state.live.size > 0 || state.status !== undefined;
}
