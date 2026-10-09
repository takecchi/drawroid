import { rm, writeFile } from 'node:fs/promises';

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

type ListBody = {
  calls: { callId: string; attempts: number; ok: boolean }[];
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
      { iteration: 1, calls: 2, inputTokens: 30, outputTokens: 12, durationMs: 300 },
      { iteration: 2, calls: 1, inputTokens: null, outputTokens: 3, durationMs: 100 },
      { iteration: null, calls: 1, inputTokens: 10, outputTokens: 5, durationMs: 100 },
    ]);
    expect(body.total).toEqual({
      calls: 4,
      inputTokens: null,
      outputTokens: 20,
      durationMs: 500,
    });
    expect(body.calls.map((c) => c.callId)).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('narrows calls and totals to one iteration with ?iteration=', async () => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls?iteration=1`);

    const body = (await res.json()) as ListBody;
    expect(body.calls.map((c) => c.callId)).toEqual(['0001', '0002']);
    expect(body.byIteration).toHaveLength(1);
    expect(body.total).toEqual({ calls: 2, inputTokens: 30, outputTokens: 12, durationMs: 300 });
  });

  it.each(['0', 'abc', '1.5', '-1'])('rejects iteration=%s with 400', async (value) => {
    const res = await env.api.request(`/jobs/${jobId}/llm-calls?iteration=${value}`);
    expect(res.status).toBe(400);
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
