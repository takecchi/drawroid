// 会話の口（一覧・作成・タイトル・確定イベント・SSE・発言・中断の枠）を HTTP で見る試験（会話 C、#109）。
// 置き場所はメモリ、ハートビートは試験が手で鳴らす偽の時計
import {
  ConversationHubs,
  type ConversationEvent,
  type ImageBackend,
  type JobStore,
  type ManualGenerationRunner,
  type MemoryStore,
} from '@drawroid/core';
import { MemoryConversationStore } from '@drawroid/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../index.js';
import {
  memoryBudgetSettings,
  memoryProgressDeps,
  noCandidateNotes,
  noPermissionSettings,
} from '../test-support.js';

let hubs: ConversationHubs;
let beats: (() => void)[];
/** 話す役の実行器へ知らせた会話 */
let kicks: string[];
let interrupts: [string, string][];
let app: ReturnType<typeof createApi>;

beforeEach(() => {
  const store = new MemoryConversationStore();
  hubs = new ConversationHubs({ store });
  beats = [];
  kicks = [];
  interrupts = [];
  const notUsed = () => Promise.reject(new Error('この試験では使わない'));
  app = createApi({
    // 会話の口はジョブとバックエンドを使わない
    backend: {} as ImageBackend,
    store: {} as JobStore,
    memoryStore: {} as MemoryStore,
    manualRunner: {} as ManualGenerationRunner,
    autoQueue: {
      kick: () => undefined,
      stop: notUsed,
      addInstruction: notUsed,
      changeStopConditions: notUsed,
      addReference: notUsed,
      addMask: notUsed,
    },
    budgetSettings: memoryBudgetSettings(),
    ...memoryProgressDeps(),
    stopConditionParser: { parse: notUsed },
    backendSettings: { read: notUsed, write: notUsed },
    llmSettings: { read: async () => undefined, write: async () => undefined },
    permissionSettings: noPermissionSettings,
    candidateNotes: noCandidateNotes,
    conversations: {
      store,
      hubs,
      turns: {
        kick: (id) => void kicks.push(id),
        interrupt: async (id, scope) => {
          interrupts.push([id, scope]);
          return { turn: true, job: scope === 'all' ? 'job-1' : undefined };
        },
      },
      heartbeat: (beat) => {
        beats.push(beat);
        return () => undefined;
      },
    },
    env: {},
  });
});

const json = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function newConversation(): Promise<string> {
  const res = await json('POST', '/conversations', {});
  expect(res.status).toBe(201);
  return ((await res.json()) as { conversation: { conversationId: string } }).conversation
    .conversationId;
}

async function say(id: string, text: string, clientMessageId?: string) {
  const res = await json('POST', `/conversations/${id}/messages`, {
    text,
    ...(clientMessageId !== undefined && { clientMessageId }),
  });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
}

type Frame = { id?: string; event?: string; data?: unknown; comment?: string };

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const frame: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });
}

/** SSE を開き、until が満たされるまで読んでから切る */
async function readStream(
  path: string,
  until: (frames: Frame[]) => boolean,
  headers: Record<string, string> = {},
  whileOpen: () => Promise<void> = async () => undefined,
): Promise<Frame[]> {
  const res = await app.request(path, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let opened = false;
  const deadline = Date.now() + 2000;
  for (;;) {
    const frames = parseFrames(text);
    if (until(frames)) {
      await reader.cancel();
      return frames;
    }
    if (Date.now() > deadline) throw new Error(`届かなかった: ${text}`);
    const read = reader.read();
    if (!opened) {
      opened = true;
      await whileOpen();
    }
    const { value, done } = await read;
    if (done) return parseFrames(text);
    text += decoder.decode(value, { stream: true });
  }
}

const confirmed = (frames: Frame[]) => frames.filter((f) => f.id !== undefined);

describe('SSE', () => {
  it('puts id: on confirmed events and none on the ones still flowing', async () => {
    const id = await newConversation();
    await say(id, '何ができますか？');
    hubs.get(id).live({ type: 'delta.text', partId: 'p1', turn: 1, text: '描けるものは' });

    const frames = await readStream(`/conversations/${id}/stream`, (f) =>
      f.some((x) => x.event === 'delta.text'),
    );

    const message = frames.find((f) => f.event === 'user.message');
    expect(message).toMatchObject({ id: '1', data: { type: 'user.message', seq: 1 } });
    const delta = frames.find((f) => f.event === 'delta.text');
    expect(delta?.id).toBeUndefined();
    expect(delta?.data).toMatchObject({ type: 'delta.text', partId: 'p1' });
  });

  it('sends only what came after Last-Event-ID, which wins over ?after=', async () => {
    const id = await newConversation();
    for (const text of ['1', '2', '3']) await say(id, text);

    const frames = await readStream(
      `/conversations/${id}/stream?after=0`,
      (f) => confirmed(f).length >= 1,
      { 'Last-Event-ID': '2' },
    );

    expect(confirmed(frames).map((f) => f.id)).toEqual(['3']);
  });

  it('lets Last-Event-ID win over ?after= even when it is the smaller one', async () => {
    const id = await newConversation();
    for (const text of ['1', '2', '3', '4']) await say(id, text);

    // 大きい方を取るのではなく、Last-Event-ID を位置とする
    const frames = await readStream(
      `/conversations/${id}/stream?after=3`,
      (f) => confirmed(f).length >= 3,
      { 'Last-Event-ID': '1' },
    );

    expect(confirmed(frames).map((f) => f.id)).toEqual(['2', '3', '4']);
  });

  it('starts from ?after= when no Last-Event-ID is sent', async () => {
    const id = await newConversation();
    for (const text of ['1', '2', '3']) await say(id, text);

    const frames = await readStream(
      `/conversations/${id}/stream?after=1`,
      (f) => confirmed(f).length >= 2,
    );

    expect(confirmed(frames).map((f) => f.id)).toEqual(['2', '3']);
  });

  it('keeps streaming what is confirmed after it was opened', async () => {
    const id = await newConversation();

    const frames = await readStream(
      `/conversations/${id}/stream`,
      (f) => confirmed(f).length >= 1,
      {},
      async () => {
        await say(id, '海辺の少女を描いて');
      },
    );

    expect(confirmed(frames)[0]).toMatchObject({ event: 'user.message', id: '1' });
  });

  it('sends a heartbeat each time the clock ticks', async () => {
    const id = await newConversation();

    const frames = await readStream(
      `/conversations/${id}/stream`,
      (f) => f.filter((x) => x.comment === 'hb').length >= 2,
      {},
      async () => {
        await Promise.resolve();
        for (const beat of beats) {
          beat();
          beat();
        }
      },
    );

    expect(frames.filter((f) => f.comment === 'hb')).toHaveLength(2);
  });

  it('answers 404 for a conversation that does not exist', async () => {
    expect((await app.request('/conversations/20261009-000000-none/stream')).status).toBe(404);
  });
});

describe('posting a message', () => {
  it('answers 202 with the seq it was confirmed at, as JSON rather than a stream', async () => {
    const id = await newConversation();

    const posted = await say(id, '海辺の少女を描いて');

    expect(posted.status).toBe(202);
    expect(posted.type).toContain('application/json');
    expect(posted.body).toEqual({ seq: 1 });
  });

  it('takes the same clientMessageId only once and answers the first seq again', async () => {
    const id = await newConversation();

    const first = await say(id, '描いて', 'm-1');
    const again = await say(id, '描いて', 'm-1');
    await say(id, '別の発言', 'm-2');

    expect(first.body).toEqual({ seq: 1 });
    expect(again).toMatchObject({ status: 202, body: { seq: 1 } });
    const events = (await (await app.request(`/conversations/${id}/events`)).json()) as {
      events: ConversationEvent[];
    };
    expect(events.events.map((e) => e.type === 'user.message' && e.clientMessageId)).toEqual([
      'm-1',
      'm-2',
    ]);
  });

  it('tells the talk runner once per message taken, and not for a resend', async () => {
    const id = await newConversation();

    await say(id, '描いて', 'm-1');
    await say(id, '描いて', 'm-1');
    await say(id, '別の発言', 'm-2');

    expect(kicks).toEqual([id, id]);
  });

  it('takes resends that arrive at the same time only once', async () => {
    const id = await newConversation();

    const posted = await Promise.all([1, 2, 3].map(() => say(id, '描いて', 'm-1')));

    expect(posted.map((p) => p.body)).toEqual([{ seq: 1 }, { seq: 1 }, { seq: 1 }]);
    const events = (await (await app.request(`/conversations/${id}/events`)).json()) as {
      events: ConversationEvent[];
    };
    expect(events.events).toHaveLength(1);
  });

  it('refuses an empty message', async () => {
    const id = await newConversation();

    expect((await say(id, '   ')).status).toBe(400);
  });
});

describe('conversations', () => {
  it('lists conversations with the title made from the first message and the start of the last one', async () => {
    const id = await newConversation();
    await say(id, '海辺の少女を描いて\n夕暮れで');
    await say(id, 'x'.repeat(100));

    const listed = (await (await app.request('/conversations')).json()) as {
      conversations: object[];
    };

    expect(listed.conversations).toEqual([
      expect.objectContaining({
        conversationId: id,
        title: '海辺の少女を描いて',
        lastMessage: 'x'.repeat(80),
        running: false,
      }),
    ]);
  });

  it('shows the reply as the last message once the talk role has answered', async () => {
    const id = await newConversation();
    await say(id, '何ができますか？');
    await hubs.get(id).confirm({ type: 'turn.started', turn: 1, messageSeqs: [1] });
    await hubs.get(id).confirm({
      type: 'assistant.message',
      turn: 1,
      partId: 'p1',
      text: '描けます。縦長と横長のどちらにしますか？',
      interrupted: false,
    });
    await hubs.get(id).confirm({
      type: 'assistant.message',
      turn: 1,
      partId: 'p2',
      text: '',
      interrupted: true,
    });

    const listed = (await (await app.request('/conversations')).json()) as {
      conversations: object[];
    };

    expect(listed.conversations).toEqual([
      expect.objectContaining({
        conversationId: id,
        lastMessage: '描けます。縦長と横長のどちらにしますか？',
      }),
    ]);
  });

  it('lets a human fix the title', async () => {
    const id = await newConversation();
    await say(id, '海辺の少女を描いて');

    const res = await json('PATCH', `/conversations/${id}`, { title: '海辺' });

    expect(res.status).toBe(200);
    const listed = (await (await app.request('/conversations')).json()) as {
      conversations: { title: string }[];
    };
    expect(listed.conversations[0]?.title).toBe('海辺');
  });

  it('reads the confirmed events a page at a time, saying where it stopped', async () => {
    const id = await newConversation();
    for (const text of ['1', '2', '3']) await say(id, text);

    const page = (await (
      await app.request(`/conversations/${id}/events?after=1&limit=1`)
    ).json()) as {
      events: ConversationEvent[];
      last: number;
      more: boolean;
    };

    expect(page.events.map((e) => e.seq)).toEqual([2]);
    expect(page).toMatchObject({ last: 2, more: true });
  });

  it('passes an interrupt for the turn or for everything to the runner, and refuses any other scope', async () => {
    const id = await newConversation();

    const turn = await json('POST', `/conversations/${id}/interrupt`, { scope: 'turn' });
    expect(turn.status).toBe(202);
    expect(await turn.json()).toEqual({ scope: 'turn', interruptedTurn: true, stoppedJob: null });
    const all = await json('POST', `/conversations/${id}/interrupt`, { scope: 'all' });
    expect(all.status).toBe(202);
    expect(await all.json()).toEqual({ scope: 'all', interruptedTurn: true, stoppedJob: 'job-1' });
    expect(interrupts).toEqual([
      [id, 'turn'],
      [id, 'all'],
    ]);
    expect((await json('POST', `/conversations/${id}/interrupt`, { scope: 'job' })).status).toBe(
      400,
    );
  });

  it('answers 404 for a conversation that does not exist', async () => {
    const missing = '20261009-000000-none';
    expect((await app.request(`/conversations/${missing}/events`)).status).toBe(404);
    expect((await json('POST', `/conversations/${missing}/messages`, { text: 'x' })).status).toBe(
      404,
    );
    expect((await json('PATCH', `/conversations/${missing}`, { title: 'x' })).status).toBe(404);
  });
});

describe('images attached in a conversation', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString(
    'base64',
  );

  it('keeps an attached image and answers its upload ID', async () => {
    const id = await newConversation();

    const res = await json('POST', `/conversations/${id}/uploads`, {
      mediaType: 'image/png',
      data: png,
    });

    expect(res.status).toBe(201);
    const { uploadId } = (await res.json()) as { uploadId: string };
    expect(uploadId).not.toBe('');
  });

  it('refuses something that is not an image of the type it says', async () => {
    const id = await newConversation();

    const res = await json('POST', `/conversations/${id}/uploads`, {
      mediaType: 'image/jpeg',
      data: png,
    });

    expect(res.status).toBe(400);
  });

  it('gives back the attached image as it was sent, with its type', async () => {
    const id = await newConversation();
    const sent = await json('POST', `/conversations/${id}/uploads`, {
      mediaType: 'image/png',
      data: png,
    });
    const { uploadId } = (await sent.json()) as { uploadId: string };

    const res = await app.request(`/conversations/${id}/uploads/${uploadId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString('base64')).toBe(png);
    // 置いたあと変わらない画像なので、長く持たせる
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  });

  it('gives back an image of another type with that type', async () => {
    const id = await newConversation();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    const sent = await json('POST', `/conversations/${id}/uploads`, {
      mediaType: 'image/jpeg',
      data: jpeg,
    });
    const { uploadId } = (await sent.json()) as { uploadId: string };

    const res = await app.request(`/conversations/${id}/uploads/${uploadId}`);

    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).toString('base64')).toBe(jpeg);
  });

  it('answers 404 for an image not attached in that conversation, or an ID of another shape', async () => {
    const id = await newConversation();
    const other = await newConversation();
    const sent = await json('POST', `/conversations/${other}/uploads`, {
      mediaType: 'image/png',
      data: png,
    });
    const { uploadId } = (await sent.json()) as { uploadId: string };

    for (const path of [
      `/conversations/${id}/uploads/${uploadId}`,
      `/conversations/${id}/uploads/..%2F..%2Fconversation.json`,
      `/conversations/no-such-conversation/uploads/${uploadId}`,
    ]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});
