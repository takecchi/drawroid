import { rm, writeFile } from 'node:fs/promises';

import type { LlmCallRecord } from '@drawroid/core';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutoJob, llmRecord, setup } from '../test-support.js';

let env: Awaited<ReturnType<typeof setup>>;
let jobId: string;

beforeEach(async () => {
  env = await setup();
  jobId = (await createAutoJob(env.store)).jobId;
  const { store } = env;
  await store.writeLlmCall(llmRecord(jobId, '0001', 1));
  await store.writeLlmCall(
    llmRecord(jobId, '0002', 1, {
      role: 'judge',
      durationMs: 200,
      usage: { inputTokens: 20, outputTokens: 7 },
      chars: { input: 50, output: 7 },
    }),
  );
  await store.writeLlmCall(
    llmRecord(jobId, '0003', 2, { usage: { inputTokens: null, outputTokens: 3 } }),
  );
  await store.writeLlmCall(llmRecord(jobId, '0004', null, { attempts: [] }));
});
afterEach(async () => {
  await rm(env.root, { recursive: true, force: true });
});

const counts = (
  calls: number,
  inputTokens: number | null,
  outputTokens: number,
  durationMs: number,
) => ({ calls, inputTokens, outputTokens, durationMs });

type ListBody = {
  calls: {
    callId: string;
    attempts: number;
    ok: boolean;
    chars: { input: number; output: number } | null;
  }[];
  byIteration: unknown[];
  total: unknown;
  invalid: { callId: string; reason: string }[];
};

describe('GET /jobs/:jobId/llm-calls', () => {
  it('sums tokens and time per iteration and in total, with null when a count is unknown', async () => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.byIteration).toEqual([
      { ...counts(2, 30, 12, 300), iteration: 1, inputChars: 150, outputChars: 27 },
      { ...counts(1, null, 3, 100), iteration: 2, inputChars: 100, outputChars: 20 },
      { ...counts(1, 10, 5, 100), iteration: null, inputChars: 100, outputChars: 20 },
    ]);
    expect(body.total).toEqual({ ...counts(4, null, 20, 500), inputChars: 350, outputChars: 67 });
    expect(body.calls.map((c) => c.callId)).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('narrows calls and totals to one iteration with ?iteration=', async () => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls?iteration=1`);

    const body = (await res.json()) as ListBody;
    expect(body.calls.map((c) => c.callId)).toEqual(['0001', '0002']);
    expect(body.byIteration).toHaveLength(1);
    expect(body.total).toEqual({ ...counts(2, 30, 12, 300), inputChars: 150, outputChars: 27 });
  });

  it.each(['0', 'abc', '1.5', '-1'])('rejects iteration=%s with 400', async (value) => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls?iteration=${value}`);
    expect(res.status).toBe(400);
  });

  it('lists the chars of each call, and says unknown for a record written before chars existed', async () => {
    const old: Partial<LlmCallRecord> = llmRecord(jobId, '0005', 1);
    delete old.chars;
    await writeFile(env.paths.jobFiles(jobId).llmCall('0005'), JSON.stringify(old));

    const body = (await (await env.api.request(`/jobs/${jobId}/llm-calls`)).json()) as ListBody;

    expect(body.invalid).toEqual([]);
    expect(Object.fromEntries(body.calls.map((c) => [c.callId, c.chars]))).toEqual({
      '0001': { input: 100, output: 20 },
      '0002': { input: 50, output: 7 },
      '0003': { input: 100, output: 20 },
      '0004': { input: 100, output: 20 },
      '0005': null,
    });
    // 数えられなかった呼び出しを 0 として足さない（トークン数と同じ）
    expect(body.total).toMatchObject({ inputChars: null, outputChars: null });
  });

  it('leaves the prompt and the outcome value out of the list', async () => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls`);
    const text = await res.text();
    expect(text).not.toContain('SYSTEM-PROMPT');
    expect(text).not.toContain('OUTCOME-VALUE');
  });

  it('reports a broken record as invalid and still lists the others', async () => {
    await writeFile(env.paths.jobFiles(jobId).llmCall('0005'), '{ broken');

    const body = (await (await env.api.request(`/jobs/${jobId}/llm-calls`)).json()) as ListBody;

    expect(body.calls).toHaveLength(4);
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0]?.callId).toBe('0005');
  });

  it('returns 404 for an unknown job', async () => {
    const res = await env.api.request('/jobs/20260101-000000-zzzzzz/llm-calls');
    expect(res.status).toBe(404);
  });
});

describe('GET /jobs/:jobId/llm-calls/:callId', () => {
  it('returns the whole record including the input and the outcome', async () => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls/0001`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      callId: '0001',
      input: { system: 'SYSTEM-PROMPT' },
      outcome: { ok: true, value: { answer: 'OUTCOME-VALUE' } },
    });
  });

  it('answers 422 invalid_file for a broken record', async () => {
    await writeFile(env.paths.jobFiles(jobId).llmCall('0005'), '{ broken');
    const res = await env.api.request(`/jobs/${jobId}/llm-calls/0005`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { kind: 'invalid_file' } });
  });

  it.each(['9999', '..%2F..%2Fjob', '0001.json'])('returns 404 for callId %s', async (callId) => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls/${callId}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown job', async () => {
    const res = await env.api.request('/jobs/20260101-000000-zzzzzz/llm-calls/0001');
    expect(res.status).toBe(404);
  });
});

// ジョブに属さない呼び出し（止める条件の変換など）。PRD:140 の「全ての LLM 呼び出し…UI で見られる」
describe('GET /llm-calls', () => {
  const unattached = (callId: string, overrides: Parameters<typeof llmRecord>[3] = {}) =>
    llmRecord('', callId, null, {
      jobId: null,
      role: 'think',
      purpose: 'stop-parse',
      ...overrides,
    });

  it('lists the calls that belong to no job, newest first, without those of the jobs', async () => {
    await env.store.writeLlmCall(unattached('20261009T000001Z-a'));
    await env.store.writeLlmCall(
      unattached('20261009T000002Z-b', {
        usage: { inputTokens: 30, outputTokens: 4 },
        chars: { input: 30, output: 4 },
      }),
    );

    const res = await env.api.request('/llm-calls');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.calls.map((c) => c.callId)).toEqual(['20261009T000002Z-b', '20261009T000001Z-a']);
    expect(body.calls[0]).toMatchObject({ purpose: 'stop-parse', iteration: null, ok: true });
    expect(body.total).toEqual({ ...counts(2, 40, 9, 200), inputChars: 130, outputChars: 24 });
    // 一覧には中身を載せない
    expect(JSON.stringify(body)).not.toContain('USER-TEXT');
  });

  it('answers an empty list before any such call was made', async () => {
    const res = await env.api.request('/llm-calls');
    expect(await res.json()).toEqual({
      calls: [],
      total: { ...counts(0, 0, 0, 0), inputChars: 0, outputChars: 0 },
      invalid: [],
    });
  });

  it('returns the whole record of one call, and 404 for a call of a job or an unknown one', async () => {
    await env.store.writeLlmCall(unattached('20261009T000001Z-a'));

    const res = await env.api.request('/llm-calls/20261009T000001Z-a');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      input: { system: 'SYSTEM-PROMPT' },
      purpose: 'stop-parse',
    });
    for (const callId of ['0001', 'missing', '..%2Fconfig']) {
      expect((await env.api.request(`/llm-calls/${callId}`)).status, callId).toBe(404);
    }
  });

  it('reports a broken record as invalid and answers 422 for it', async () => {
    await env.store.writeLlmCall(unattached('20261009T000001Z-a'));
    await writeFile(`${env.paths.llmCalls}/20261009T000002Z-x.json`, '{ broken');

    const list = (await (await env.api.request('/llm-calls')).json()) as ListBody;
    expect(list.calls.map((c) => c.callId)).toEqual(['20261009T000001Z-a']);
    expect(list.invalid.map((i) => i.callId)).toEqual(['20261009T000002Z-x']);
    expect((await env.api.request('/llm-calls/20261009T000002Z-x')).status).toBe(422);
  });
});
