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
      /** 途切れたあと、同じ本文がもう送られた（「送り直す」を外す） */
      resent?: boolean;
      /** 添えた画像の枚数 */
      attachments: number;
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
  | {
      kind: 'images';
      key: string;
      jobId: string;
      iteration: number;
      images: ChatImage[];
      /** 頼んだ画像の大きさ。縦横の比として、読み込む前から画像の背を取るのに使う。古い記録には無い */
      size?: { width: number; height: number };
    }
  | {
      kind: 'judge';
      key: string;
      jobId: string;
      iteration: number;
      canStop: boolean;
      nextChange: string;
    }
  | {
      kind: 'adopted';
      key: string;
      jobId: string;
      iteration: number;
      image: { iteration: number; index: number };
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
      /** 途中の画像（設定で有効なときだけ） */
      previewUrl?: string;
    }
  | { kind: 'status'; key: string; status: ChatStatus }
  /** 人間の発言を聞くあいだ、ジョブを待たせている（status と寿命が違うので別の行にする） */
  | { kind: 'held'; key: string };

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
  /** 待たされているジョブ。空でない間は「話を聞いています」を出す */
  held: Set<string>;
}

export const EMPTY_CHAT_STATE: ChatState = {
  confirmed: [],
  live: new Map(),
  progress: new Map(),
  status: undefined,
  held: new Set(),
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
  return applyConfirmedAll(state, [event]);
}

/**
 * 確定したイベントをまとめて取り込む（`applyConfirmed` を順に当てたのと同じ）。
 * 写しを作るのは1度だけ: 1件ずつ写すと、長い会話を開くときの読み込みがイベントの数の二乗で重くなるため。
 */
export function applyConfirmedAll(
  state: ChatState,
  events: readonly ConversationEvent[],
): ChatState {
  let draft: ChatState | undefined;
  for (const event of events) {
    const current = draft ?? state;
    // ふつうは末尾に足すだけ: 毎回全件から同じ seq を探すと、長い会話の読み込みがイベントの数の二乗で重くなるため
    const appends = event.seq > lastSeq(current);
    if (!appends && current.confirmed.some((existing) => existing.seq === event.seq)) continue;
    draft ??= {
      confirmed: [...state.confirmed],
      live: new Map(state.live),
      progress: new Map(state.progress),
      status: state.status,
      held: new Set(state.held),
    };
    draft.confirmed.push(event);
    if (!appends) draft.confirmed.sort((a, b) => a.seq - b.seq);
    draft.status = confirmInto(draft, event);
  }
  return draft ?? state;
}

/** 確定したイベント1件で、書きかけ・進み具合・待ち・状態を直す（`draft` をその場で書き換え、新しい状態を返す） */
function confirmInto(draft: ChatState, event: ConversationEvent): ChatStatus | undefined {
  const { live, progress, held } = draft;
  let status = draft.status;

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
      held.delete(event.jobId);
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
  return status;
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
    case 'job.held': {
      const held = new Set(state.held);
      if (event.held) held.add(event.jobId);
      else held.delete(event.jobId);
      return { ...state, held };
    }
  }
}

function reasoningLabel(source: ReasoningSource | undefined): string {
  if (source === undefined || source.role === 'talk') return '思考';
  return source.role === 'think'
    ? `考える役の思考（${source.iteration} 回目）`
    : `見る役の思考（${source.iteration} 回目）`;
}

const imagesKey = (jobId: string, iteration: number) => `images:${jobId}:${iteration}`;

/**
 * 確定したイベントの行の並びを作る。イベントの数に比例する手間で作る: 長い会話では、行を前から探し直すと二乗で重くなるため。
 * 前の行を書き換えるもの（送り直し・ツールの結果・評価・途切れ）は、行の位置を覚えておいて直接書き換える。
 */
function buildConfirmedItems(confirmed: readonly ConversationEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, number>();
  const images = new Map<string, number>();
  const userIndex = new Map<number, number>();
  const userByTurn = new Map<number, number>();
  const interruptedByText = new Map<string, number[]>();

  for (const event of confirmed) {
    const key = `seq:${event.seq}`;
    switch (event.type) {
      case 'user.message': {
        // 送り直した元の行からは「送り直す」を外す: 残すと、もう一度押して同じ発言（描いて、など）を二重に送れてしまうため
        for (const index of interruptedByText.get(event.text) ?? []) {
          items[index] = { ...(items[index] as ItemOf<'user'>), resent: true };
        }
        userIndex.set(event.seq, items.length);
        items.push({
          kind: 'user',
          key,
          seq: event.seq,
          at: event.at,
          text: event.text,
          attachments: event.attachments.length,
        });
        break;
      }
      case 'turn.started':
        for (const seq of event.messageSeqs) {
          const index = userIndex.get(seq);
          if (index !== undefined) userByTurn.set(event.turn, index);
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
        tools.set(event.callId, items.length);
        items.push(item);
        break;
      }
      case 'tool.result': {
        const index = tools.get(event.callId);
        if (index === undefined) break;
        items[index] = {
          ...(items[index] as ItemOf<'tool'>),
          state: event.ok ? 'ok' : 'error',
          summary: event.summary,
        };
        break;
      }
      case 'turn.ended':
        if (event.outcome === 'error')
          items.push({ kind: 'turn-error', key, reason: event.reason });
        if (event.outcome === 'interrupted') {
          // 途中で途切れたターンは、読んだ発言に「送り直す」を出す（設計: 復帰）
          const index = userByTurn.get(event.turn);
          if (index !== undefined) {
            const user = items[index] as ItemOf<'user'>;
            items[index] = { ...user, turnInterrupted: event.reason ?? '応答が途中で途切れた' };
            interruptedByText.set(user.text, [...(interruptedByText.get(user.text) ?? []), index]);
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
          ...(event.size !== undefined && { size: event.size }),
        };
        images.set(item.key, items.length);
        items.push(item);
        break;
      }
      case 'job.judge': {
        // 評価は、同じ回の画像の行に重ねる: 画像と点数が離れて並ぶと、どの画像の点数か追いにくいため
        const index = images.get(imagesKey(event.jobId, event.iteration));
        if (index !== undefined) {
          const shown = items[index] as ItemOf<'images'>;
          const scored = {
            ...shown,
            images: shown.images.map((image) => {
              const judged = event.images.find((candidate) => candidate.index === image.index);
              return judged === undefined
                ? image
                : { ...image, score: judged.score, issues: judged.issues };
            }),
          };
          items[index] = scored;
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
      case 'job.adopted':
        items.push({
          kind: 'adopted',
          key,
          jobId: event.jobId,
          iteration: event.iteration,
          image: event.image,
        });
        break;
      case 'job.stopped':
        items.push({ kind: 'job-stopped', key, jobId: event.jobId, reason: event.reason });
        break;
      case 'job.intervention':
        break;
    }
  }
  return items;
}

// 確定したイベントの配列は、取り込むたびに新しく作り直し、作ったあとは書き換えない（applyConfirmedAll）。だから配列ごとに覚えてよい
const confirmedItemsCache = new WeakMap<readonly ConversationEvent[], ChatItem[]>();

/** 同じ確定の配列には、同じ行（同じオブジェクト）を返す: 書きかけの増分だけが変わる間、確定した行を描き直さずに済むため */
function confirmedItems(confirmed: readonly ConversationEvent[]): ChatItem[] {
  let items = confirmedItemsCache.get(confirmed);
  if (items === undefined) {
    items = buildConfirmedItems(confirmed);
    confirmedItemsCache.set(confirmed, items);
  }
  return items;
}

/** ログの行の並びを作る */
export function chatItems(state: ChatState): ChatItem[] {
  const items = [...confirmedItems(state.confirmed)];
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
      previewUrl: progress.previewUrl,
    });
  }
  // 状態の行は1つだけ: ジョブを待たせている間は、考えている最中でも「話を聞いています」を出す
  if (state.held.size > 0) items.push({ kind: 'held', key: 'held' });
  else if (state.status !== undefined)
    items.push({ kind: 'status', key: 'status', status: state.status });
  return items;
}

/** 今の状態（読み上げに知らせる）。行の並びの状態の行と同じ決め方にする */
export function currentStatus(state: ChatState): ChatStatus | 'job.held' | undefined {
  return state.held.size > 0 ? 'job.held' : state.status;
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
  return (
    turnOpen ||
    jobs.size > 0 ||
    state.live.size > 0 ||
    state.status !== undefined ||
    state.held.size > 0
  );
}
