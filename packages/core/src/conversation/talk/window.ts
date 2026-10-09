import type { ConversationEvent } from '../events.js';
import type { ConversationStore } from '../store.js';

type JobStarted = Extract<ConversationEvent, { type: 'job.started' }>;
type TurnStarted = Extract<ConversationEvent, { type: 'turn.started' }>;

/** 話す役の1ターンが読む、会話の末尾 */
export type TalkWindow = {
  /** 末尾のイベント（seq の順）。会話の最後のジョブの job.started が末尾より前なら、それを先頭に足してある */
  events: ConversationEvent[];
  /** まだどのターンも読んでいない人間の発言の seq */
  unread: number[];
  /** 次のターンの番号 */
  nextTurn: number;
  /** 読んだ中で最も古い seq。頭まで読んだなら undefined */
  oldest: number | undefined;
  /** 読んだ中の発言（人間と話す役）の数 */
  said: number;
};

/**
 * 話す役の1ターンに要る分だけを、会話の末尾から読む。要るのは次のとおり。
 * - 最後の turn.started と、それが読んだ発言まで（未読の発言と、次のターンの番号を決めるため）
 * - 直近の発言（入力の組み立てが渡す件数）
 * - 会話の最後のジョブの job.started（ジョブの要約と drawing_status のため）
 * 会話を頭から全部読むと、長い会話でターンの立ち上がりが会話の長さに比例して遅くなるため。
 */
// 未読をここまでで決めてよい理由: ターンは始まるときに未読の発言を全部読むので、最後の turn.started が読んだ
// 最も古い発言より前の発言は、どれもどこかのターンが読み済み。その範囲の発言を読んだ turn.started は、発言より後にあるので、
// 読んだ範囲に入っている
export class TalkWindowReader {
  /** 会話ごとに、どの seq まで見たか と、そこまでの最後の job.started。ジョブが遠い会話で、毎ターン頭まで読まないため */
  private readonly lastJobs = new Map<string, { upTo: number; job: JobStarted | undefined }>();

  constructor(
    private readonly store: Pick<ConversationStore, 'readEventsBefore'>,
    private readonly pageSize = 100,
  ) {}

  async read(conversationId: string, recentMessages: number): Promise<TalkWindow> {
    const known = this.lastJobs.get(conversationId);
    const newestFirst: ConversationEvent[] = [];
    let lastTurn: TurnStarted | undefined;
    let job: JobStarted | undefined;
    let said = 0;
    let before: number | undefined;
    let reachedStart = false;
    // 遡るほどページを広げる: 遠いジョブを探すときに、置き場所への問い合わせの回数を会話の長さの対数に抑えるため
    let limit = this.pageSize;
    for (;;) {
      const page = await this.store.readEventsBefore(conversationId, {
        ...(before === undefined ? {} : { before }),
        limit,
      });
      for (const event of page.toReversed()) {
        newestFirst.push(event);
        if (event.type === 'turn.started') lastTurn ??= event;
        if (event.type === 'job.started') job ??= event;
        if (event.type === 'user.message' || event.type === 'assistant.message') said += 1;
      }
      if (page.length < limit) {
        reachedStart = true;
        break;
      }
      limit *= 2;
      const oldest = page[0]!.seq;
      before = oldest;
      const turnCovered =
        lastTurn !== undefined && oldest <= Math.min(lastTurn.seq, ...lastTurn.messageSeqs);
      const jobSettled = job !== undefined || (known !== undefined && oldest <= known.upTo + 1);
      if (turnCovered && said >= recentMessages && jobSettled) break;
    }
    const tail = newestFirst.toReversed();
    // 末尾に job.started が無ければ、前に見たものを使う（前に見た範囲より後は、すべて読んだ）
    job ??= known?.job;
    this.lastJobs.set(conversationId, { upTo: tail.at(-1)?.seq ?? known?.upTo ?? 0, job });

    const read = new Set(
      tail.flatMap((event) => (event.type === 'turn.started' ? event.messageSeqs : [])),
    );
    return {
      events: job !== undefined && !tail.includes(job) ? [job, ...tail] : tail,
      unread: tail.flatMap((event) =>
        event.type === 'user.message' && !read.has(event.seq) ? [event.seq] : [],
      ),
      nextTurn: (lastTurn?.turn ?? 0) + 1,
      oldest: reachedStart ? undefined : before,
      said,
    };
  }

  /**
   * 直近の発言が recentMessages 件に足りなければ、読んだ範囲より前を読み足す。未読と次のターンの番号は変えない
   * （どちらも読んだ範囲で決まっている）。設定で直近の件数を増やしたときのため
   */
  async widen(
    conversationId: string,
    window: TalkWindow,
    recentMessages: number,
  ): Promise<TalkWindow> {
    let { oldest, said } = window;
    const older: ConversationEvent[] = [];
    while (oldest !== undefined && said < recentMessages) {
      const page = await this.store.readEventsBefore(conversationId, {
        before: oldest,
        limit: this.pageSize,
      });
      older.unshift(...page);
      said += page.filter(
        (e) => e.type === 'user.message' || e.type === 'assistant.message',
      ).length;
      oldest = page.length < this.pageSize ? undefined : page[0]!.seq;
    }
    if (older.length === 0) return window;
    // 先頭に足した job.started が、読み足した範囲に入ったら、二重にしない
    const kept = window.events.filter(
      (e) => !older.includes(e) && !older.some((o) => o.seq === e.seq),
    );
    return { ...window, events: [...older, ...kept], oldest, said };
  }
}
