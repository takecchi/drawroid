import { describe, expect, it } from 'vitest';

import { ApiError, readApiError, unwrap } from './api-error.js';

const respond = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
});

describe('readApiError', () => {
  it('reads kind and message from the API error body', async () => {
    const error = await readApiError(
      respond(502, {
        error: { kind: 'unreachable', message: 'http://127.0.0.1:7860/ に繋がらない' },
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: 'unreachable',
      message: 'http://127.0.0.1:7860/ に繋がらない',
      status: 502,
    });
  });

  it('keeps the status when the body is not the API error shape', async () => {
    for (const body of [
      { error: 'not_found' },
      { error: { kind: 1 } },
      null,
      'html',
      new Error('x'),
    ]) {
      expect(await readApiError(respond(404, body)), String(body)).toMatchObject({
        kind: 'unknown',
        status: 404,
      });
    }
  });
});

describe('unwrap', () => {
  it('returns the body of a successful response', async () => {
    expect(await unwrap(async () => respond(200, { jobId: 'a' }))).toEqual({ jobId: 'a' });
  });

  it('throws the API error of a failed response', async () => {
    await expect(
      unwrap(async () => respond(400, { error: { kind: 'invalid_request', message: 'bad' } })),
    ).rejects.toMatchObject({ kind: 'invalid_request', message: 'bad', status: 400 });
  });

  it('turns a failure to reach the API into a network error', async () => {
    await expect(
      unwrap(async () => {
        throw new TypeError('fetch failed');
      }),
    ).rejects.toMatchObject({ kind: 'network', status: null });
  });
});
