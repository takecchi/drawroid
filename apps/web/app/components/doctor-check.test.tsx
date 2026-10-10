// @vitest-environment jsdom
import { ApiError, runDoctor } from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordedDoctor } from '../test-support/recorded-doctor';
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
    vi.mocked(runDoctor).mockResolvedValue(recordedDoctor);
    renderCheck();
    const user = userEvent.setup();
    expect(runDoctor).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '確かめる' }));

    expect(runDoctor).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/足りないものが 2 つある/)).toBeTruthy();
    const config = screen.getByRole('region', { name: '設定ファイル' });
    expect(within(config).getByText('よい')).toBeTruthy();
    expect(within(config).getByText('読める（<データディレクトリ>/config.json）')).toBeTruthy();
    const llm = screen.getByRole('region', { name: 'LLM' });
    expect(within(llm).getByText('足りない')).toBeTruthy();
    expect(
      within(llm).getByText(
        'すること: drawroid を起動し、画面の「設定」の「LLM の設定」（/settings#llm）で provider と考える役のモデルを入れる',
      ),
    ).toBeTruthy();
    const web = screen.getByRole('region', { name: 'web の配り先' });
    expect(within(web).getByText('ある（<web の配り先>）')).toBeTruthy();
  });

  it('says all is fine when nothing is lacking', async () => {
    // すべてよい応答は、実機の Forge と LLM が要るので記録していない。記録した応答のうち、よい節だけを使う
    const { sections } = recordedDoctor.report;
    vi.mocked(runDoctor).mockResolvedValue({
      report: { sections: sections.filter(({ items }) => items.every(({ ok }) => ok)), lacking: 0 },
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
