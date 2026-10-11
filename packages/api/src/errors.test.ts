import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';

import { handleUncaught } from './errors.js';
import { memoryRoutes } from './routes/memory.js';

function appThrowing(error: Error) {
  return new Hono()
    .get('/', () => {
      throw error;
    })
    .onError(handleUncaught);
}

async function answer(error: Error) {
  const res = await appThrowing(error).request('/');
  return { status: res.status, body: (await res.json()) as unknown };
}

describe('handleUncaught with an HTTPException', () => {
  it('says a body that is not JSON in Japanese, with hono’s sentence in parentheses', async () => {
    expect(
      await answer(new HTTPException(400, { message: 'Malformed JSON in request body' })),
    ).toEqual({
      status: 400,
      body: {
        error: {
          kind: 'invalid_request',
          message: '(body): JSON として読めない（原文: Malformed JSON in request body）',
        },
      },
    });
  });

  it('says any other refusal with its status first and the original sentence in parentheses', async () => {
    expect(await answer(new HTTPException(418, { message: 'I am a teapot' }))).toEqual({
      status: 418,
      body: { error: { kind: 'http_error', message: 'HTTP 418 で断った（原文: I am a teapot）' } },
    });
  });

  it('keeps invalid_request for a 400 that is not about JSON, and says it the same way', async () => {
    expect(
      await answer(new HTTPException(400, { message: 'Malformed FormData request.' })),
    ).toEqual({
      status: 400,
      body: {
        error: {
          kind: 'invalid_request',
          message: 'HTTP 400 で断った（原文: Malformed FormData request.）',
        },
      },
    });
  });

  it('does not return the message of an unexpected failure', async () => {
    const { status, body } = await answer(new Error('/home/someone/secret/config.json'));

    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('the memory routes and the app-wide handler', () => {
  it('say a body that is not JSON the same way, apart from the original sentence', async () => {
    const memory = memoryRoutes({
      budgetSettings: { read: () => Promise.reject(new Error('not used')) },
    } as unknown as Parameters<typeof memoryRoutes>[0]);
    const res = await memory.request('/abc', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const inMemory = ((await res.json()) as { error: { message: string } }).error.message;

    const app = (
      await answer(new HTTPException(400, { message: 'Malformed JSON in request body' }))
    ).body as { error: { message: string } };

    expect(app.error.message.startsWith(inMemory)).toBe(true);
  });
});
