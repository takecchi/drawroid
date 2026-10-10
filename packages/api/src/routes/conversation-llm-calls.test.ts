// 話す役の LLM 呼び出しの記録（conversations/<id>/llm-calls/）を、ジョブの分と同じ形で読む口
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationHubs } from '@drawroid/core';
import { dataPaths, FsConversationStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutoJob, llmRecord, setup } from '../test-support.js';

let env: Awaited<ReturnType<typeof setup>>;
let dataRoot: string;
let conversations: FsConversationStore;
let id: string;
let otherId: string;

const talk = (callId: string, overrides: Parameters<typeof llmRecord>[3] = {}) =>
  llmRecord('', callId, null, { jobId: null, role: 'talk', purpose: 'talk', ...overrides });

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'drawroid-api-conv-'));
  conversations = new FsConversationStore(dataRoot);
  env = await setup({
    conversations: { store: conversations, hubs: new ConversationHubs({ store: conversations }) },
  });
  id = (await conversations.createConversation(new Date('2026-10-09T06:30:00Z'))).conversationId;
  otherId = (await conversations.createConversation(new Date('2026-10-09T06:31:00Z')))
    .conversationId;
});
afterEach(async () => {
  await rm(env.root, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

type ListBody = {
  calls: {
    callId: string;
    role: string;
    attempts: number;
    ok: boolean;
    chars: { input: number; output: number } | null;
  }[];
  total: unknown;
  invalid: { callId: string; reason: string }[];
};

const callsDir = (conversationId: string) =>
  dataPaths(dataRoot).conversationFiles(conversationId).llmCalls;

describe('GET /conversations/:conversationId/llm-calls', () => {
  it('lists the calls of the conversation newest first, with the same totals as the other lists', async () => {
    await conversations.writeLlmCall(id, talk('20261009T000001Z-a'));
    await conversations.writeLlmCall(
      id,
      talk('20261009T000002Z-b', {
        usage: { inputTokens: 30, outputTokens: 4 },
        chars: { input: 30, output: 4 },
        durationMs: 200,
      }),
    );

    const res = await env.api.request(`/conversations/${id}/llm-calls`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.calls.map((c) => c.callId)).toEqual(['20261009T000002Z-b', '20261009T000001Z-a']);
    expect(body.calls[0]).toMatchObject({
      role: 'talk',
      ok: true,
      attempts: 0,
      chars: { input: 30, output: 4 },
    });
    expect(body.total).toEqual({
      calls: 2,
      inputTokens: 40,
      outputTokens: 9,
      durationMs: 300,
      inputChars: 130,
      outputChars: 24,
    });
    expect(JSON.stringify(body)).not.toContain('USER-TEXT');
  });

  it('answers an empty list before any call was made', async () => {
    const res = await env.api.request(`/conversations/${id}/llm-calls`);
    expect(await res.json()).toEqual({
      calls: [],
      total: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        inputChars: 0,
        outputChars: 0,
      },
      invalid: [],
    });
  });

  it('leaves out the calls of another conversation, of a job and of no job', async () => {
    await conversations.writeLlmCall(id, talk('20261009T000001Z-a'));
    await conversations.writeLlmCall(otherId, talk('20261009T000002Z-other'));
    const { jobId } = await createAutoJob(env.store);
    await env.store.writeLlmCall(llmRecord(jobId, '0001', 1));
    await env.store.writeLlmCall(talk('20261009T000003Z-unattached'));

    const body = (await (
      await env.api.request(`/conversations/${id}/llm-calls`)
    ).json()) as ListBody;

    expect(body.calls.map((c) => c.callId)).toEqual(['20261009T000001Z-a']);
  });

  it('reports a broken record as invalid and still lists the others', async () => {
    await conversations.writeLlmCall(id, talk('20261009T000001Z-a'));
    await writeFile(join(callsDir(id), '20261009T000002Z-x.json'), '{ broken');

    const body = (await (
      await env.api.request(`/conversations/${id}/llm-calls`)
    ).json()) as ListBody;

    expect(body.calls.map((c) => c.callId)).toEqual(['20261009T000001Z-a']);
    expect(body.invalid.map((i) => i.callId)).toEqual(['20261009T000002Z-x']);
    expect(body.invalid[0]?.reason).not.toBe('');
  });

  it('returns 404 for an unknown conversation, and for an ID of the wrong shape', async () => {
    for (const bad of ['20260101-000000-zzzzzz', '..%2Fx']) {
      expect((await env.api.request(`/conversations/${bad}/llm-calls`)).status, bad).toBe(404);
    }
  });
});

describe('GET /conversations/:conversationId/llm-calls/:callId', () => {
  it('returns the whole record including the input and the outcome', async () => {
    await conversations.writeLlmCall(id, talk('20261009T000001Z-a'));

    const res = await env.api.request(`/conversations/${id}/llm-calls/20261009T000001Z-a`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      callId: '20261009T000001Z-a',
      role: 'talk',
      input: { system: 'SYSTEM-PROMPT' },
      outcome: { ok: true, value: { answer: 'OUTCOME-VALUE' } },
    });
  });

  it('answers 422 invalid_file for a broken record', async () => {
    await conversations.writeLlmCall(id, talk('20261009T000001Z-a'));
    await writeFile(join(callsDir(id), '20261009T000002Z-x.json'), '{ broken');

    const res = await env.api.request(`/conversations/${id}/llm-calls/20261009T000002Z-x`);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_file' } });
  });

  it('answers 404 for a call of another conversation, an unlisted name and an unknown conversation', async () => {
    await conversations.writeLlmCall(otherId, talk('20261009T000002Z-other'));
    // 一覧に無い名前で、会話の外のファイルを読ませない
    await writeFile(join(dataRoot, 'secret.json'), JSON.stringify(talk('secret')));

    for (const callId of ['20261009T000002Z-other', 'missing', '..%2F..%2Fsecret', 'x.json']) {
      const res = await env.api.request(`/conversations/${id}/llm-calls/${callId}`);
      expect(res.status, callId).toBe(404);
    }
    const unknown = await env.api.request(
      '/conversations/20260101-000000-zzzzzz/llm-calls/20261009T000002Z-other',
    );
    expect(unknown.status).toBe(404);
  });
});
