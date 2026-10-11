// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Settings from './settings';

// 欄の中身は見ない: 画面が、案内のリンクの行き先の欄へフォーカスを移すかだけを見る
vi.mock('../components/backend-status', () => ({
  BackendStatus: () => <h2>バックエンドの状態</h2>,
}));
vi.mock('../components/backend-url-settings', () => ({
  BackendUrlSettings: () => <h2>バックエンドの URL</h2>,
}));
vi.mock('../components/llm-settings', () => ({
  LlmSettings: () => (
    <section>
      <h2>LLM の設定</h2>
      <input aria-label="考える役のモデル" />
    </section>
  ),
}));
vi.mock('../components/generation-progress-settings', () => ({
  GenerationProgressSettings: () => <h2>生成の途中の画像</h2>,
}));
vi.mock('../components/budget-settings', () => ({
  BudgetInvalidNotice: () => null,
  BudgetSettings: () => <p>予算の欄</p>,
}));
vi.mock('../components/doctor-check', () => ({
  DoctorCheck: () => <h2>まとめて確かめる</h2>,
}));

afterEach(cleanup);

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/"
          element={
            <>
              <Link to="/settings#llm">LLM を設定する</Link>
              <Link to="/settings#backend">バックエンドを設定する</Link>
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Settings, reached from a link to one of its parts', () => {
  // 画面は欄まで流れても、フォーカスが本文の頭に残ると、キーボードと読み上げの人は欄まで辿り直すことになる
  it('moves the focus to the heading of the part the link points at', async () => {
    renderAt('/');

    await userEvent.setup().click(screen.getByRole('link', { name: 'LLM を設定する' }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'LLM の設定' })),
    );
  });

  it('moves the focus to the part named in the address when the page is opened with it', async () => {
    renderAt('/settings#backend');

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'バックエンドの状態' }),
      ),
    );
  });

  it('moves the focus to the summary of the folded part', async () => {
    renderAt('/settings#budgets');

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText('詳しい設定（LLM に渡す量の予算）')),
    );
  });

  it('leaves the focus alone when the address names no part', async () => {
    renderAt('/settings');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.activeElement).toBe(document.body);
  });
});
