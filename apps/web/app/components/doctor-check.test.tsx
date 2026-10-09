// @vitest-environment jsdom
import { ApiError, runDoctor } from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DoctorCheck } from './doctor-check';

// 画面では行き先（Router）の中で描かれる: 結果に会話への道（Link）を置くため
const renderCheck = () =>
  render(
    <MemoryRouter>
      <DoctorCheck />
    </MemoryRouter>,
  );

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  runDoctor: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('DoctorCheck', () => {
  it('runs the check on click and shows each item as fine or lacking, with what to do', async () => {
    vi.mocked(runDoctor).mockResolvedValue({
      report: {
        sections: [
          { title: '設定ファイル', items: [{ ok: true, what: '読める' }] },
          {
            title: 'LLM',
            items: [
              {
                ok: false,
                what: 'まだ設定していない',
                todo: '「LLM の設定」で provider と考える役のモデルを入れる',
              },
            ],
          },
        ],
        lacking: 1,
      },
    });
    renderCheck();
    const user = userEvent.setup();
    expect(runDoctor).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '確かめる' }));

    expect(runDoctor).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/足りないものが 1 つある/)).toBeTruthy();
    const config = screen.getByRole('region', { name: '設定ファイル' });
    expect(within(config).getByText('よい')).toBeTruthy();
    expect(within(config).getByText('読める')).toBeTruthy();
    const llm = screen.getByRole('region', { name: 'LLM' });
    expect(within(llm).getByText('足りない')).toBeTruthy();
    expect(
      within(llm).getByText('すること: 「LLM の設定」で provider と考える役のモデルを入れる'),
    ).toBeTruthy();
  });

  it('says all is fine when nothing is lacking', async () => {
    vi.mocked(runDoctor).mockResolvedValue({
      report: {
        sections: [{ title: 'web の配り先', items: [{ ok: true, what: 'ある' }] }],
        lacking: 0,
      },
    });
    renderCheck();

    await userEvent.setup().click(screen.getByRole('button', { name: '確かめる' }));

    expect(await screen.findByText(/すべてよい/)).toBeTruthy();
    // そのまま描き始められるように、会話への道がある
    expect(screen.getByRole('link', { name: '会話へ' }).getAttribute('href')).toBe('/');
  });

  it('shows why the check could not run', async () => {
    vi.mocked(runDoctor).mockRejectedValue(
      new ApiError('unavailable', 'この起動では、画面から確かめられない', 409),
    );
    renderCheck();

    await userEvent.setup().click(screen.getByRole('button', { name: '確かめる' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '確かめられなかった: この起動では、画面から確かめられない',
    );
  });
});
