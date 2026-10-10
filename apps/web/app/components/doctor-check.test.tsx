// @vitest-environment jsdom
import { ApiError, runDoctor } from '@drawroid/swr';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

/** フォーカスが、element を含む箱にあるか。body は何でも含むので、body にあるときは除く */
const focusHolds = (element: Element) =>
  document.activeElement !== document.body && document.activeElement?.contains(element) === true;

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

  // 「確かめる」は設定の画面のいちばん下にあり、結果はボタンの下（画面の外）に出る。結果へ目を移せないと、押しても何も起きないように見える
  it('moves focus to the result when the check finishes, so that it comes into view', async () => {
    vi.mocked(runDoctor).mockResolvedValue(recordedDoctor);
    renderCheck();
    expect(document.activeElement).toBe(document.body);

    await userEvent.setup().click(screen.getByRole('button', { name: '確かめる' }));

    const verdict = await screen.findByText(/足りないものが 2 つある/);
    expect(focusHolds(verdict)).toBe(true);
  });

  it('moves focus to the reason when the check could not run', async () => {
    vi.mocked(runDoctor).mockRejectedValue(
      new ApiError('unavailable', 'この起動では、画面から確かめられない', 409),
    );
    renderCheck();

    await userEvent.setup().click(screen.getByRole('button', { name: '確かめる' }));

    const reason = await screen.findByRole('alert');
    expect(focusHolds(reason)).toBe(true);
  });

  // 待つ間にボタンが押せなくなると、ブラウザによってはフォーカスを body へ落とす。どこにもフォーカスが無いときも結果へ移す。
  // （jsdom は押せなくなったボタンからフォーカスを外せないので、フォーカスを動かさずに押して、body のまま待つ形で見る）
  it('moves focus to the result when the focus is nowhere when the check finishes', async () => {
    let settle: () => void = () => undefined;
    vi.mocked(runDoctor).mockImplementation(
      () => new Promise((resolve) => (settle = () => resolve(recordedDoctor))),
    );
    renderCheck();

    fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    expect(document.activeElement).toBe(document.body);
    settle();

    const verdict = await screen.findByText(/足りないものが 2 つある/);
    expect(focusHolds(verdict)).toBe(true);
  });

  // 待つ間に人がほかの欄へ移っていたら、結果へ引き戻さない（打っている途中の文字が、結果の箱に吸われるため）
  it.each([
    ['finishes', true, /足りないものが 2 つある/],
    ['could not run', false, /確かめられなかった/],
  ])(
    'leaves focus on the field the person moved to when the check %s, with the outcome still shown',
    async (_, succeeds, outcome) => {
      let settle: () => void = () => undefined;
      vi.mocked(runDoctor).mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              succeeds
                ? resolve(recordedDoctor)
                : reject(new ApiError('unavailable', 'この起動では、画面から確かめられない', 409));
          }),
      );
      render(
        <MemoryRouter>
          <input aria-label="ほかの欄" />
          <DoctorCheck />
        </MemoryRouter>,
      );
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: '確かめる' }));
      const field = screen.getByRole('textbox', { name: 'ほかの欄' });
      await user.click(field);
      await user.keyboard('abc');
      settle();

      expect(await screen.findByText(outcome)).toBeTruthy();
      expect(document.activeElement).toBe(field);
      expect((field as HTMLInputElement).value).toBe('abc');
    },
  );

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

  // 200 でも返事が読めないとき（壊れた JSON・report の無い体）に、待つ印を出したままにも、画面を白くもしない
  it.each([
    [
      'the answer is not JSON',
      () =>
        vi
          .mocked(runDoctor)
          .mockRejectedValue(
            new SyntaxError("Expected property name or '}' in JSON at position 1"),
          ),
    ],
    ['the answer has no report', () => vi.mocked(runDoctor).mockResolvedValue({} as never)],
    [
      'the report has no sections',
      () => vi.mocked(runDoctor).mockResolvedValue({ report: { lacking: 1 } } as never),
    ],
    [
      'an item of the report is not in shape',
      () =>
        vi.mocked(runDoctor).mockResolvedValue({
          report: { lacking: 0, sections: [{ title: 'LLM', items: [{}] }] },
        } as never),
    ],
  ])('says the result could not be read when %s', async (_, answer) => {
    answer();
    renderCheck();

    await userEvent.setup().click(screen.getByRole('button', { name: '確かめる' }));

    const reason = await screen.findByRole('alert');
    expect(reason.textContent).toContain('確かめの結果が読めなかった');
    expect(focusHolds(reason)).toBe(true);
    expect(screen.queryByText(/確かめています/)).toBeNull();
    expect(screen.getByRole('button', { name: '確かめる' }).hasAttribute('disabled')).toBe(false);
  });
});
