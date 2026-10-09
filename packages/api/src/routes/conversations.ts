import type { ConversationStore, HubMessage } from '@drawroid/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { createMessageIntake } from '../conversation-messages.js';
import type { ApiDeps } from '../deps.js';
import { notFound } from '../errors.js';
import { referenceUploadSchema } from '../references.js';
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
  attachments: z.array(z.object({ uploadId: z.string().min(1) })).optional(),
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

const defaultHeartbeat = (beat: () => void) => {
  const timer = setInterval(beat, HEARTBEAT_MS);
  return () => clearInterval(timer);
};

/** 一覧の1行: 最後の発言（人間か話す役か）の先頭と、ターンが走っているか（turn.started があって turn.ended が無い） */
async function summarize(store: ConversationStore, conversationId: string) {
  let lastMessage = '';
  const open = new Set<number>();
  let after = 0;
  for (;;) {
    const page = await store.readEvents(conversationId, { after });
    for (const event of page.events) {
      // 本文の無い返答（ツールだけ呼んで打ち切られたものなど）で、前の発言を消さない
      if (
        (event.type === 'user.message' || event.type === 'assistant.message') &&
        event.text.trim() !== ''
      )
        lastMessage = event.text.slice(0, LAST_MESSAGE_CHARS);
      if (event.type === 'turn.started') open.add(event.turn);
      if (event.type === 'turn.ended') open.delete(event.turn);
    }
    after = page.last;
    if (!page.more) break;
  }
  return { lastMessage, running: open.size > 0 };
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

  return (
    new Hono()
      .get('/', async (c) => {
        const ids = (await store.listConversationIds()).sort().reverse();
        const list = [];
        for (const conversationId of ids) {
          const conversation = await store.readConversation(conversationId);
          list.push({ ...conversation, ...(await summarize(store, conversationId)) });
        }
        return c.json({ conversations: list }, 200);
      })
      .post('/', async (c) => {
        const conversation = await store.createConversation(new Date());
        return c.json({ conversation }, 201);
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
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        const { data, mediaType } = c.req.valid('json');
        const uploadId = await store.addUpload(id, { data, mediaType }, new Date());
        return c.json({ uploadId }, 201);
      })
      // 中断の口の枠。ターンを走らせるのは後の段（会話 E・I）で、今は受けるだけ
      .post('/:conversationId/interrupt', jsonBody(interruptSchema), async (c) => {
        const id = c.req.param('conversationId');
        if (!(await store.hasConversation(id))) return notFound(c, missing(id));
        return c.json({ scope: c.req.valid('json').scope }, 202);
      })
  );
}
