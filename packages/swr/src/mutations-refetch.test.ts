// @vitest-environment jsdom
// 走行中の操作のあとに、画面の該当する一覧を取り直すことを見る試験（#68 の W10・W11）。
// fetch は差し替え、swr の mutate に渡されるキーを記録する
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from './keys.js';
import {
  addInstruction,
  changeStopConditions,
  postConversationMessage,
  renameConversation,
} from './mutations.js';

const mutated: unknown[] = [];
vi.mock('swr', () => ({
  default: vi.fn(),
  mutate: (key: unknown) => {
    mutated.push(key);
    return Promise.resolve();
  },
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  mutated.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refetching after an operation on a running job', () => {
  it('refetches the stop conditions after changing them', async () => {
    fetchMock.mockResolvedValue(
      json(202, { stopConditions: { aiJudgement: true, maxIterations: 5 } }),
    );
    await changeStopConditions('j1', { maxIterations: 5 });
    expect(mutated).toContain(keys.stopConditions('j1'));
  });

  it('refetches the interventions after adding an instruction', async () => {
    fetchMock.mockResolvedValue(
      json(202, {
        intervention: {
          kind: 'instruction',
          interventionId: '000001',
          receivedAt: '2026-10-09T00:00:00.000Z',
          text: 'もっと青く',
        },
      }),
    );
    await addInstruction('j1', 'もっと青く');
    expect(mutated).toContain(keys.interventions('j1'));
  });
});

// 一覧（並びと要約）と会話1つ（タイトル）の両方を取り直す
describe('refetching after an operation on a conversation', () => {
  it('refetches the list and the conversation after renaming it', async () => {
    fetchMock.mockResolvedValue(
      json(200, { conversation: { conversationId: 'c1', createdAt: '', title: '海' } }),
    );
    await renameConversation('c1', '海');
    expect(mutated).toContain(keys.conversations);
    expect(mutated).toContain(keys.conversation('c1'));
  });

  it('refetches the list and the conversation after posting a message', async () => {
    fetchMock.mockResolvedValue(json(202, { seq: 3 }));
    await postConversationMessage('c1', '描いて', 'm-1');
    expect(mutated).toContain(keys.conversations);
    expect(mutated).toContain(keys.conversation('c1'));
  });
});
