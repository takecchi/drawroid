import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setup } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await rm(ctx.root, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  ctx.api.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function refusalMessage(res: Response): Promise<string> {
  expect(res.status).toBe(400);
  const { error } = (await res.json()) as { error: { kind: string; message: string } };
  expect(error.kind).toBe('invalid_request');
  return error.message;
}

const stringExpected = (received: string) =>
  `の値が違う（文字列で書く）（原文: Invalid input: expected string, received ${received}）`;

const validMemory = {
  body: '好み',
  tags: [],
  scope: 'always',
  expectedUpdatedAt: '2026-10-09T00:00:00.000Z',
};

describe('the 400 of an input that zod refuses, on every route', () => {
  it.each([
    [
      'POST /jobs/:jobId/adopt',
      'POST',
      '/jobs/j/adopt',
      { iteration: '1', index: 0 },
      'iteration の値が違う（数で書く）（原文: Invalid input: expected number, received string）',
    ],
    ['POST /jobs/auto', 'POST', '/jobs/auto', { request: 1 }, `request ${stringExpected('number')}`],
    [
      'PUT /backend/candidate-notes',
      'PUT',
      '/backend/candidate-notes',
      { 'ink wash': 1 },
      `ink wash ${stringExpected('number')}`,
    ],
    [
      'PATCH /conversations/:id',
      'PATCH',
      '/conversations/c',
      { title: 1 },
      `title ${stringExpected('number')}`,
    ],
    [
      'GET /conversations/:id/events (query)',
      'GET',
      '/conversations/c/events?limit=0',
      undefined,
      'limit の値が違う（0 より大きい）（原文: Too small: expected number to be >0）',
    ],
    [
      'POST /conversations/:id/messages',
      'POST',
      '/conversations/c/messages',
      { text: 1 },
      `text ${stringExpected('number')}`,
    ],
    [
      'POST /conversations/:id/uploads',
      'POST',
      '/conversations/c/uploads',
      { mediaType: 'image/bmp', data: 'AAAA' },
      'mediaType の値が違う（"image/png"・"image/jpeg"・"image/webp" のどれか）（原文: Invalid option: expected one of "image/png"|"image/jpeg"|"image/webp"）',
    ],
    [
      'POST /conversations/:id/interrupt',
      'POST',
      '/conversations/c/interrupt',
      { scope: 'some' },
      'scope の値が違う（"turn" か "all" のどちらか）（原文: Invalid option: expected one of "turn"|"all"）',
    ],
    [
      'PUT /settings/generation-progress',
      'PUT',
      '/settings/generation-progress',
      { includePreview: 'yes' },
      'includePreview の値が違う（true か false で書く）（原文: Invalid input: expected boolean, received string）',
    ],
    [
      'POST /jobs/auto/:jobId/interventions',
      'POST',
      '/jobs/auto/j/interventions',
      { kind: 'instruction', text: 1 },
      `text ${stringExpected('number')}`,
    ],
    [
      'PUT /settings/permissions',
      'PUT',
      '/settings/permissions',
      { nope: 1 },
      '(body) の値が違う（知らない欄 nope）（原文: Unrecognized key: "nope"）',
    ],
    [
      'PUT /jobs/:jobId/selections/:imageKey',
      'PUT',
      '/jobs/j/selections/1-0',
      { verdict: 'maybe' },
      'verdict の値が違う（"favorite" か "rejected" のどちらか）（原文: Invalid option: expected one of "favorite"|"rejected"）',
    ],
    [
      'PUT /settings/backend',
      'PUT',
      '/settings/backend',
      { kind: 'nope' },
      'kind の値が違う（"forge" か "a1111" のどちらか）（原文: Invalid option: expected one of "forge"|"a1111"）',
    ],
    [
      'POST /jobs/manual',
      'POST',
      '/jobs/manual',
      { prompt: 1, steps: 4, cfgScale: 7, width: 64, height: 64 },
      `prompt ${stringExpected('number')}`,
    ],
    [
      'PUT /memory/:id',
      'PUT',
      '/memory/m',
      { ...validMemory, scope: 'nope' },
      'scope の値が違う（"always" か "tagged" のどちらか）（原文: Invalid option: expected one of "always"|"tagged"）',
    ],
    [
      'POST /stop-conditions/parse',
      'POST',
      '/stop-conditions/parse',
      { text: 1 },
      `text ${stringExpected('number')}`,
    ],
  ])(
    '%s says the field in Japanese with the original in parentheses',
    async (_route, method, path, body, message) => {
      expect(await refusalMessage(await send(method, path, body))).toBe(message);
    },
  );

  it.each([
    [
      'a memory body that is empty',
      'PUT',
      '/memory/m',
      { ...validMemory, body: '  ' },
      'body: 本文が空',
    ],
    [
      'a backend URL that is not http',
      'PUT',
      '/settings/backend',
      { url: 'ftp://localhost' },
      'url: URL は http:// か https:// で始まる形で書く',
    ],
    [
      'a backend update that changes nothing',
      'PUT',
      '/settings/backend',
      {},
      '(body): url か kind の少なくとも一方が要る',
    ],
    [
      'a stop condition sentence that is empty',
      'POST',
      '/stop-conditions/parse',
      { text: ' ' },
      'text: 止める条件の文が空',
    ],
    [
      'a message that is empty',
      'POST',
      '/conversations/c/messages',
      { text: ' ' },
      'text: 発言が空',
    ],
  ])(
    'keeps the sentence of %s as "field: sentence" without the original',
    async (_name, method, path, body, message) => {
      expect(await refusalMessage(await send(method, path, body))).toBe(message);
    },
  );

  it('does not name config.json and does not repeat the value that was sent', async () => {
    const message = await refusalMessage(
      await send('POST', '/jobs/auto', { request: 'x', batchSize: 'SECRET-VALUE' }),
    );

    expect(message).not.toContain('config.json');
    expect(message).not.toContain('SECRET-VALUE');
  });
});
