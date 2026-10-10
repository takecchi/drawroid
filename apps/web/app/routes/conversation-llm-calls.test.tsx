// @vitest-environment jsdom
import { useConversationLlmCalls } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConversationLlmCallsRoute from './conversation-llm-calls';
import routes from '../routes';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useConversationLlmCalls: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('the LLM calls page of a conversation', () => {
  it('reads the calls of the conversation in the address and says there is none yet', () => {
    vi.mocked(useConversationLlmCalls).mockReturnValue({
      data: {
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
      },
      error: undefined,
    } as never);

    render(
      <MemoryRouter initialEntries={['/conversations/c-1/llm-calls']}>
        <Routes>
          <Route
            path="/conversations/:conversationId/llm-calls"
            element={<ConversationLlmCallsRoute />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(useConversationLlmCalls).toHaveBeenCalledWith('c-1');
    expect(screen.getByRole('heading', { name: 'この会話の LLM 呼び出し' })).toBeTruthy();
    expect(screen.getByText('まだ無い。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '会話へ戻る' }).getAttribute('href')).toBe(
      '/conversations/c-1',
    );
  });

  it('is routed at /conversations/:conversationId/llm-calls', () => {
    const paths = (routes as { path?: string; file: string }[]).map((r) => [r.path, r.file]);
    expect(paths).toContainEqual([
      'conversations/:conversationId/llm-calls',
      'routes/conversation-llm-calls.tsx',
    ]);
  });
});
