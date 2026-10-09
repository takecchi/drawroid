import {
  conversationEventSchema,
  liveEventSchema,
  type ConversationEvent,
  type LiveEvent,
} from '@drawroid/core';
import { useEffect, useReducer } from 'react';

import {
  applyConfirmed,
  applyConfirmedAll,
  applyLive,
  EMPTY_CHAT_STATE,
  lastSeq,
  type ChatState,
} from './chat-state';

/** SSE の `event:` に来る名前（確定するもの・しないもの） */
export const STREAM_EVENT_TYPES = [
  ...conversationEventSchema.options.map((option) => option.shape.type.value),
  ...liveEventSchema.options.map((option) => option.shape.type.value),
] as const;

/** ブラウザの EventSource のうち、ここで使う口だけ（試験で偽物に差し替えるため） */
export interface StreamLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface EventPage {
  events: unknown[];
  /** このページの最後の seq */
  last: number;
  /** 続きがあるか */
  more: boolean;
}

/** 会話のイベントの取り出し口。本物は API（会話 C）、試験では偽物を渡す */
export interface ConversationSource {
  loadEvents(conversationId: string, after: number): Promise<EventPage>;
  /** after より後を流す購読を開く。再接続と Last-Event-ID はブラウザに任せる */
  openStream(conversationId: string, after: number): StreamLike;
}

type Action =
  | { type: 'reset' }
  /** 読み込んだページまでを畳んだもの。購読を開く前だけ使う（ほかから状態が変わらない間） */
  | { type: 'restored'; chat: ChatState }
  | { type: 'confirmed'; event: ConversationEvent }
  | { type: 'live'; event: LiveEvent }
  | { type: 'loaded' }
  | { type: 'failed'; message: string };

interface StreamState {
  chat: ChatState;
  loaded: boolean;
  error: string | undefined;
}

const INITIAL: StreamState = { chat: EMPTY_CHAT_STATE, loaded: false, error: undefined };

function reduce(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case 'reset':
      return INITIAL;
    case 'restored':
      return { ...state, chat: action.chat };
    case 'confirmed':
      return { ...state, chat: applyConfirmed(state.chat, action.event) };
    case 'live':
      return { ...state, chat: applyLive(state.chat, action.event) };
    case 'loaded':
      return { ...state, loaded: true };
    case 'failed':
      return { ...state, error: action.message };
  }
}

/** SSE の data を読む。形が合わないものは捨てる: 1件の壊れたイベントで、画面ごと止めないため */
export function parseStreamData(data: string): Action | undefined {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const confirmed = conversationEventSchema.safeParse(json);
  if (confirmed.success) return { type: 'confirmed', event: confirmed.data };
  const live = liveEventSchema.safeParse(json);
  if (live.success) return { type: 'live', event: live.data };
  return undefined;
}

/**
 * 会話を開く: 確定したイベントをページ単位で全部読み、そのあと最後の seq から購読を開く（設計: 復帰）。
 * 読み終えるまで購読を開かない: 開いてから読むと、同じ seq が二度届く窓ができる（二度目は捨てるが、行が揺れる）ため。
 */
export function useConversationStream(conversationId: string, source: ConversationSource) {
  const [state, dispatch] = useReducer(reduce, INITIAL);

  useEffect(() => {
    let closed = false;
    let stream: StreamLike | undefined;
    dispatch({ type: 'reset' });

    async function open() {
      let after = 0;
      let chat = EMPTY_CHAT_STATE;
      for (;;) {
        const page = await source.loadEvents(conversationId, after);
        if (closed) return;
        const events = [];
        for (const raw of page.events) {
          const parsed = conversationEventSchema.safeParse(raw);
          if (parsed.success) events.push(parsed.data);
        }
        chat = applyConfirmedAll(chat, events);
        // 進まないページで回り続けない: 置き場所が more を返し続けても、画面を固めないため
        if (!page.more || page.last <= after) break;
        after = page.last;
      }
      // 読み終えてから1度だけ渡す: ページごとに渡すと、そのたびにそこまでの全部の行を描き直し、長い会話ほど開くのが重くなるため
      dispatch({ type: 'restored', chat });
      dispatch({ type: 'loaded' });
      stream = source.openStream(conversationId, lastSeq(chat));
      for (const type of STREAM_EVENT_TYPES) {
        stream.addEventListener(type, (event) => {
          const action = parseStreamData(event.data);
          if (action !== undefined) dispatch(action);
        });
      }
    }

    open().catch((error: unknown) => {
      if (!closed)
        dispatch({
          type: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      closed = true;
      stream?.close();
    };
  }, [conversationId, source]);

  return state;
}
