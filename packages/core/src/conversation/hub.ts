import type { ConversationEvent, LiveEvent, NewConversationEvent } from './events.js';
import type { ConversationStore } from './store.js';

/** 購読者へ渡すもの。確定したイベントには seq があり、SSE で id: を付ける */
export type HubMessage =
  { kind: 'confirmed'; event: ConversationEvent } | { kind: 'live'; event: LiveEvent };

export interface HubSubscription {
  close(): void;
  readonly closed: boolean;
}

type Subscriber = {
  send: (message: HubMessage) => void;
  /** 確定したイベントを読み終えるまでは、届いたものを溜めておく */
  buffer: HubMessage[] | undefined;
  closed: boolean;
};

/** 写しの鍵。増分は部品ごと、進み具合はジョブの回ごと、状態は1つだけ持つ */
function copyKeyOf(event: LiveEvent): string {
  switch (event.type) {
    case 'delta.text':
    case 'delta.reasoning':
      return `part:${event.partId}`;
    case 'generation.progress':
      return `progress:${event.jobId}:${event.iteration}`;
    case 'status':
      return 'status';
  }
}

/** 確定したイベントが終わらせる写し。そのイベントが確定した時点で、写しは古くなる */
function endsCopy(event: ConversationEvent, key: string): boolean {
  if ('partId' in event && key === `part:${event.partId}`) return true;
  switch (event.type) {
    case 'job.images':
      return key === `progress:${event.jobId}:${event.iteration}`;
    case 'job.stopped':
      return key.startsWith(`progress:${event.jobId}:`);
    case 'turn.ended':
      return key === 'status';
    default:
      return false;
  }
}

/**
 * 会話1つのハブ。イベントを確定して置き場所に書き、購読者へ流す。確定しない部品（増分・進み具合・状態）は、
 * 走っている間の写しだけをメモリに持ち、ファイルには書かない。
 */
export class ConversationHub {
  private readonly store: ConversationStore;
  private readonly conversationId: string;
  private readonly now: () => Date;
  private readonly copies = new Map<string, LiveEvent>();
  private readonly subscribers = new Set<Subscriber>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(deps: { store: ConversationStore; conversationId: string; now?: () => Date }) {
    this.store = deps.store;
    this.conversationId = deps.conversationId;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * イベントを確定する。書き終えてから、写しを捨て、購読者へ流す。
   */
  // 書き込みを会話の中で直列にする: 書けた順と流す順を、seq の順に揃えるため
  confirm(event: NewConversationEvent): Promise<ConversationEvent> {
    const run = this.writing.then(async () => {
      const confirmed = await this.store.appendEvent(this.conversationId, event, this.now());
      // ここから流し終えるまで await を挟まない: 写しを捨てることと流すことの間に、購読が割り込まないように
      for (const key of [...this.copies.keys()]) {
        if (endsCopy(confirmed, key)) this.copies.delete(key);
      }
      this.fanOut({ kind: 'confirmed', event: confirmed });
      return confirmed;
    });
    // 1件の失敗で後ろの確定を止めない
    this.writing = run.catch(() => undefined);
    return run;
  }

  /** 確定しない部品を流す。写しを更新し、ファイルには書かない */
  live(event: LiveEvent): void {
    const key = copyKeyOf(event);
    const copy = this.copies.get(key);
    // 増分は足し込んで、ここまでの全文を写しにする: 後から購読した画面が、写し1つで続きを出せるように
    if (
      copy !== undefined &&
      (event.type === 'delta.text' || event.type === 'delta.reasoning') &&
      copy.type === event.type
    ) {
      this.copies.set(key, { ...event, text: copy.text + event.text });
    } else {
      this.copies.set(key, event);
    }
    this.fanOut({ kind: 'live', event });
  }

  /**
   * after より後の確定したイベントから購読する。取りこぼしも二重渡しも起こさないように、次の順で流す。
   * 1. 購読を張り、同じ同期区間で写しを取る（以後に届いたものは溜める）
   * 2. after より後の確定したイベントを置き場所から読んで流す
   * 3. 写しを流す（読んでいる間に確定した部品の写しは、古いので流さない）
   * 4. 溜めたものを流す（2 で流した seq 以下は落とす。落とした確定より前の、その確定で終わった部品の増分も落とす）
   */
  async subscribe(after: number, send: (message: HubMessage) => void): Promise<HubSubscription> {
    const subscriber: Subscriber = { send, buffer: [], closed: false };
    this.subscribers.add(subscriber);
    const snapshot = [...this.copies.values()];
    const subscription: HubSubscription = {
      close: () => this.close(subscriber),
      get closed() {
        return subscriber.closed;
      },
    };

    let last = after;
    try {
      for (;;) {
        const page = await this.store.readEvents(this.conversationId, { after: last });
        for (const event of page.events) {
          this.deliver(subscriber, { kind: 'confirmed', event });
        }
        last = page.last;
        if (!page.more) break;
      }
    } catch (error) {
      this.close(subscriber);
      throw error;
    }

    const buffered = subscriber.buffer ?? [];
    subscriber.buffer = undefined;
    const confirmedLater = buffered.flatMap((m) => (m.kind === 'confirmed' ? [m.event] : []));
    for (const copy of snapshot) {
      const key = copyKeyOf(copy);
      if (confirmedLater.some((event) => endsCopy(event, key))) continue;
      this.deliver(subscriber, { kind: 'live', event: copy });
    }
    // 後ろから見て、すでに流した確定（seq <= last）が終わらせた部品の増分を落とす
    const stale = new Set<number>();
    const endedBy: ConversationEvent[] = [];
    for (let i = buffered.length - 1; i >= 0; i--) {
      const message = buffered[i]!;
      if (message.kind === 'confirmed') {
        if (message.event.seq <= last) endedBy.push(message.event);
      } else if (endedBy.some((event) => endsCopy(event, copyKeyOf(message.event)))) {
        stale.add(i);
      }
    }
    for (const [i, message] of buffered.entries()) {
      if (stale.has(i)) continue;
      if (message.kind === 'confirmed' && message.event.seq <= last) continue;
      this.deliver(subscriber, message);
    }
    return subscription;
  }

  private fanOut(message: HubMessage): void {
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.buffer !== undefined) subscriber.buffer.push(message);
      else this.deliver(subscriber, message);
    }
  }

  // 購読者の失敗はその購読者だけを外す: 1人の切れた接続で、ほかの購読者と書き手を止めないため
  private deliver(subscriber: Subscriber, message: HubMessage): void {
    if (subscriber.closed) return;
    try {
      subscriber.send(message);
    } catch {
      this.close(subscriber);
    }
  }

  private close(subscriber: Subscriber): void {
    subscriber.closed = true;
    subscriber.buffer = undefined;
    this.subscribers.delete(subscriber);
  }
}

/** 会話ごとのハブを持つ。同じ会話には同じハブを返す */
export class ConversationHubs {
  private readonly hubs = new Map<string, ConversationHub>();

  constructor(private readonly deps: { store: ConversationStore; now?: () => Date }) {}

  get(conversationId: string): ConversationHub {
    let hub = this.hubs.get(conversationId);
    if (hub === undefined) {
      hub = new ConversationHub({ ...this.deps, conversationId });
      this.hubs.set(conversationId, hub);
    }
    return hub;
  }
}
