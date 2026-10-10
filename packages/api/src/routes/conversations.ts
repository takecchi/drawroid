import type { ConversationStore, HubMessage } from '@drawroid/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { createMessageIntake } from '../conversation-messages.js';
import type { ApiDeps } from '../deps.js';
import { invalidRequest, notFound } from '../errors.js';
import { imageProblem } from '../images.js';
import { MAX_REFERENCES_PER_REQUEST, referenceUploadSchema } from '../references.js';
import { jsonBody, queryParams } from '../validate.js';

/** SSE のハートビートの既定の間隔 */
export const HEARTBEAT_MS = 15_000;
/** 一覧に出す、最後の発言の先頭の文字数 */
const LAST_MESSAGE_CHARS = 80;

const MAX_MESSAGE_CHARS = 8000;

const messageSchema = z.object({
  text: z
    .string()
    .max(MAX_MESSAGE_CHARS)
    .refine((text) => text.trim() !== '', { message: '発言が空' }),
  // 参照画像と同じ枚数にそろえる: 画面は同じ上限で添えさせ、添えた画像は描き始めるときにジョブの参照画像になるため
  attachments: z
    .array(z.object({ uploadId: z.string().min(1) }))
    .max(MAX_REFERENCES_PER_REQUEST)
    .optional(),
  clientMessageId: z.string().min(1).max(200).optional(),
});

const titleSchema = z.object({ title: z.string().trim().min(1).max(200) });

const interruptSchema = z.object({ scope: z.enum(['turn', 'all']) });

const seqSchema = z.coerce.number().int().nonnegative();

const eventsQuerySchema = z.object({
  after: seqSchema.default(0),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

/** 再開の位置。Last-Event-ID を ?after= より優先する（ブラウザが自分でつなぎ直すとき、URL の after は開いたときのままのため） */
function resumeAfter(lastEventId: string | undefined, after: string | undefined): number {
  for (const value of [lastEventId, after]) {
    if (value === undefined || value.trim() === '') continue;
    const parsed = seqSchema.safeParse(value.trim());
    if (parsed.success) return parsed.data;
  }
  return 0;
}

/** 既定のハートビート: HEARTBEAT_MS ごとに鳴らす。止める関数を返す（試験が既定の間隔を偽の時計で見るために出す） */
export const defaultHeartbeat = (beat: () => void) => {
  const timer = setInterval(beat, HEARTBEAT_MS);
  return () => clearInterval(timer);
};

/** 一覧の要約で、末尾から最初に読む行の数。足りなければ倍々に広げて遡る */
const SUMMARY_TAIL_PAGE = 32;

/**
 * 一覧の1行: 最後の発言（人間か話す役か）の先頭と、ターンが走っているかと、最後に何かが起きた時刻（行が無ければ作った時刻）。
 * 走っているかは、末尾から遡って最初に当たるターンの印で決める（turn.started なら走っている、turn.ended なら止まっている）
 */
// 頭から全部は読まない: 一覧を開くたびに全会話の全行を読むと、会話が溜まるほど一覧が遅くなる。
// ターンは会話ごとに1つずつ回り、どの終わり方でも turn.ended を書くので、最後のターンの印だけで決まる（起動時の復帰と同じ前提）
async function summarize(
  store: ConversationStore,
  conversation: { conversationId: string; createdAt: string },
) {
  let lastMessage: string | undefined;
  let running: boolean | undefined;
  let lastActiveAt: string | undefined;
  let before: number | undefined;
  // 遡るほどページを広げる: ジョブの行が長く続いてターンの印が遠いときも、問い合わせの回数を会話の長さの対数に抑えるため
  let limit = SUMMARY_TAIL_PAGE;
  for (;;) {
    const page = await store.readEventsBefore(conversation.conversationId, {
      ...(before === undefined ? {} : { before }),
      limit,
    });
    for (const event of page.toReversed()) {
      lastActiveAt ??= event.at;
      // 本文の無い返答（ツールだけ呼んで打ち切られたものなど）は、最後の発言にしない
      if (
        lastMessage === undefined &&
        (event.type === 'user.message' || event.type === 'assistant.message') &&
        event.text.trim() !== ''
      )
        lastMessage = event.text.slice(0, LAST_MESSAGE_CHARS);
      if (running === undefined && event.type === 'turn.started') running = true;
      if (running === undefined && event.type === 'turn.ended') running = false;
    }
    if (page.length < limit || (lastMessage !== undefined && running !== undefined)) break;
    before = page[0]!.seq;
    limit *= 2;
  }
  return {
    lastMessage: lastMessage ?? '',
    running: running ?? false,
    lastActiveAt: lastActiveAt ?? conversation.createdAt,
  };
}

/**
 * 会話の口。発言の POST はストリームを返さず、流すのは GET の購読（SSE）1本だけにする。
 */
// 流す口を1本にする: 画面がブラウザ標準の EventSource を使え、つなぎ直しと Last-Event-ID をブラウザに任せられるため
export function conversationsRoutes({ conversations }: ApiDeps) {
  const { store, hubs } = conversations;
  const heartbeat = conversations.heartbeat ?? defaultHeartbeat;
  const intake = createMessageIntake(conversations);
  const missing = (id: string) => `会話 ${id} は無い`;
  // 一覧の要約を、会話ごとに最後のイベントの seq と組で覚える（メモリの中だけ。索引のファイルは作らない）。
  // 一覧の画面は数秒ごとに読み直すので、変わっていない会話の末尾まで毎回読むと、会話が溜まるほど重くなるため
  const summaries = new Map<
    string,
    { seq: number; summary: Awaited<ReturnType<typeof summarize>> }
  >();

  /**
   * 会話の要約。最後のイベントを1件だけ読み、その seq が覚えたものと同じなら覚えた要約を使う。違えば末尾から読み直す。
   * 毎回ファイルの最後の seq と比べるので、別のプロセスが足したイベントや、起動し直したあとも古い要約を返さない
   */
  // seq で比べ、時刻やファイルの更新時刻では比べない: 確定したイベントは足されるだけで書き換えられないので、最後の seq が同じなら中身も同じため
  async function summaryOf(conversation: { conversationId: string; createdAt: string }) {
    const [last] = await store.readEventsBefore(conversation.conversationId, { limit: 1 });
    const seq = last?.seq ?? 0;
    const known = summaries.get(conversation.conversationId);
    if (known !== undefined && known.seq === seq) return known.summary;
    const summary = await summarize(store, conversation);
    summaries.set(conversation.conversationId, { seq, summary });
    return summary;
  }

  return (
    new Hono()
      .get('/', async (c) => {
        const ids = (await store.listConversationIds()).sort().reverse();
        const list = [];
        for (const conversationId of ids) {
          // タイトルは覚えない: 名前の変更（PATCH）はイベントを足さないので、seq では変わったことが分からないため
          const conversation = await store.readConversation(conversationId);
          list.push({ ...conversation, ...(await summaryOf(conversation)) });
        }
        // 消えた会話の要約は手放す
        const listed = new Set(ids);
        for (const conversationId of summaries.keys()) {
          if (!listed.has(conversationId)) summaries.delete(conversationId);
        }
        // 最後に何かが起きた順（新しい順）に並べる: 作った順だと、前に作って今も続けている会話が下に埋もれるため。
        // 同じ時刻は作った順（ID の降順）のまま
        list.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
        return c.json({ conversations: list }, 200);
      })
      .post('/', async (c) => {
        const conversation = await store.createConversation(new Date());
        return c.json({ conversation }, 201);
      })
      // 1つだけ読む口を置く: 会話の画面がタイトルのために一覧を読むと、全会話の要約（末尾の行の読み出し）を数秒ごとに払うため
      .get('/:conversationId', async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        return c.json({ conversation: await store.readConversation(id) }, 200);
      })
      .patch('/:conversationId', jsonBody(titleSchema), async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const conversation = { ...(await store.readConversation(id)), ...c.req.valid('json') };
        await store.writeConversation(conversation);
        return c.json({ conversation }, 200);
      })
      .get('/:conversationId/events', queryParams(eventsQuerySchema), async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const { after, limit } = c.req.valid('query');
        return c.json(await store.readEvents(id, { after, limit }), 200);
      })
      .get('/:conversationId/stream', async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const after = resumeAfter(c.req.header('Last-Event-ID'), c.req.query('after'));
        return streamSSE(c, async (stream) => {
          // 書き込みを1本の列に並べる: ハブは同期で渡してくるが、SSE の書き込みは非同期で、順を崩さないため
          let writing: Promise<unknown> = Promise.resolve();
          const enqueue = (write: () => Promise<unknown>) => {
            writing = writing.then(write).catch(() => stream.abort());
          };
          const send = (message: HubMessage) => {
            // 切れた接続へは書かない: 投げてハブから外してもらう
            if (stream.aborted || stream.closed) throw new Error('購読が切れた');
            const { event } = message;
            enqueue(() =>
              stream.writeSSE({
                ...(message.kind === 'confirmed' && { id: String(message.event.seq) }),
                event: event.type,
                data: JSON.stringify(event),
              }),
            );
          };
          const subscription = await hubs.get(id).subscribe(after, send);
          // 書き込みの失敗は握りつぶして購読を外す: 1本の切れた接続で、ほかを止めないため
          const stop = heartbeat(() => {
            if (stream.aborted || stream.closed) return;
            enqueue(() => stream.write(': hb\n\n'));
          });
          await new Promise<void>((resolve) => {
            if (stream.aborted) resolve();
            else stream.onAbort(resolve);
          });
          stop();
          subscription.close();
        });
      })
      .post('/:conversationId/messages', jsonBody(messageSchema), async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const { seq } = await intake.post(id, c.req.valid('json'));
        return c.json({ seq }, 202);
      })
      // 会話で添える画像。描き始めるときに、ジョブの参照画像へ写す（用途の言葉は、描き始めるときに話す役が付ける）
      .post('/:conversationId/uploads', jsonBody(referenceUploadSchema), async (c) => {
        const id = c.req.param('conversationId');
        const { data, mediaType } = c.req.valid('json');
        const problem = await imageProblem(data, mediaType);
        if (problem !== undefined) return invalidRequest(c, `data: ${problem}`);
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const uploadId = await store.addUpload(id, { data, mediaType }, new Date());
        return c.json({ uploadId }, 201);
      })
      // 会話で添えた画像を読む（人の発言の行に並べる）。ID の形は置き場所が確かめ、合わなければ無い扱いにする
      .get('/:conversationId/uploads/:uploadId', async (c) => {
        const { conversationId: id, uploadId } = c.req.param();
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const upload = await store.readUpload(id, uploadId);
        if (upload === undefined) return notFound(c, `添えた画像 ${uploadId} は無い`);
        // 長く持たせる: 添えた画像は置いたあと変わらず、同じ ID で別の画像になることも無いため
        return c.body(upload.data as Uint8Array<ArrayBuffer>, 200, {
          'content-type': upload.mediaType,
          'cache-control': 'private, max-age=31536000, immutable',
        });
      })
      // 中断。turn は走っている話す役のターンだけ、all はそれに加えて会話のジョブも止める。
      // 走っているものが無くても 202 で受ける（何もしない）。応答には、実際に打ち切った・止めたものを返す
      .post('/:conversationId/interrupt', jsonBody(interruptSchema), async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const { scope } = c.req.valid('json');
        const done = (await conversations.turns?.interrupt(id, scope)) ?? {
          turn: false,
          job: undefined,
        };
        return c.json({ scope, interruptedTurn: done.turn, stoppedJob: done.job ?? null }, 202);
      })
  );
}
