// @vitest-environment jsdom
import type { SelectionVerdict } from '@drawroid/core';
import { ApiError, recheckJobDistill, setSelection } from '@drawroid/swr';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChooseAsFavorite } from './choose-as-favorite';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  recheckJobDistill: vi.fn(),
  setSelection: vi.fn(),
}));

const JOB = '20261009-153112-a3f9c1';
const CHOOSE = 'この画像に決める（お気に入りにする）: 2 回目の画像 1 番';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// 移さないことは、すぐに確かめるだけでは、遅れて移す形を見逃す。しばらく待ってからもう一度確かめる
const expectFocusStaysOn = async (element: Element) => {
  expect(document.activeElement).toBe(element);
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(document.activeElement).toBe(element);
};

let setVerdict: (verdict: SelectionVerdict | null) => void = () => undefined;

/**
 * 同じ画像のボタンを、止まりのカード（目立つ形）と画像の行に並べる。選び方は1つを共有する
 * （本物では、どちらも同じ選び方の読み込みから出る）
 */
function CardAndRow({ initial = null }: { initial?: SelectionVerdict | null }) {
  const [verdict, set] = useState<SelectionVerdict | null>(initial);
  setVerdict = set;
  const props = { jobId: JOB, imageKey: '2-0', imageLabel: '2 回目の画像 1 番', verdict };
  return (
    <>
      <section aria-label="カード">
        <ChooseAsFavorite {...props} prominent />
      </section>
      <section aria-label="行">
        <ChooseAsFavorite {...props} />
      </section>
    </>
  );
}

/** 本物の setSelection は、選び方を読み直してから返る。読み直したことにしてから返す */
function savesTheSelection() {
  vi.mocked(setSelection).mockImplementation(async (_job, _key, verdict) => {
    act(() => setVerdict(verdict));
    return {} as never;
  });
  vi.mocked(recheckJobDistill).mockResolvedValue(undefined as never);
}

describe('ChooseAsFavorite refusal', () => {
  const renderOne = () => {
    render(
      <ChooseAsFavorite
        jobId={JOB}
        imageKey="2-0"
        imageLabel="2 回目の画像 1 番"
        verdict={null}
      />,
    );
    return userEvent.setup();
  };

  // 読み上げに聞こえるよう role=alert で出す。文は変えない
  it('says why the image could not be chosen as an alert, with the same words', async () => {
    vi.mocked(setSelection).mockRejectedValue(new ApiError('conflict', '画像が無い', 409));
    const user = renderOne();

    await user.click(screen.getByRole('button', { name: CHOOSE }));

    expect((await screen.findByRole('alert')).textContent).toBe('決められない: 画像が無い');
  });

  // 押したボタンは送っている間押せなくなり、フォーカスが落ちるので、断りへ移る。2回続けて断られても移る
  it('moves the focus to the refusal, also on a second refusal', async () => {
    vi.mocked(setSelection).mockRejectedValue(new ApiError('conflict', '画像が無い', 409));
    const user = renderOne();
    const choose = () => screen.getByRole('button', { name: CHOOSE });

    choose().focus();
    await user.keyboard('{Enter}');
    const first = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(first));

    choose().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(setSelection).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const second = screen.getByRole('alert');
      expect(second).not.toBe(first);
      expect(document.activeElement).toBe(second);
    });
  });
});

describe('ChooseAsFavorite focus', () => {
  // 押したボタンは決めた印に替わって消える。フォーカスは、押した所の印へ移る（同じ画像の、ほかの所の印へは移さない）
  it('moves the focus to the mark where the person chose the image', async () => {
    savesTheSelection();
    const user = userEvent.setup();
    render(<CardAndRow />);

    const card = screen.getByRole('region', { name: 'カード' });
    card.querySelector('button')!.focus();
    await user.keyboard('{Enter}');

    const marks = screen.getAllByText('この画像に決めた（お気に入り）');
    expect(marks).toHaveLength(2);
    // 押し終えたすぐあとに確かめない: フォーカスを移すのは描いたあとの effect で、act の外で結果が届くと、まだ走っていないことがある
    await waitFor(() => expect(document.activeElement).toBe(card.querySelector('p')));
  });

  // 開き直したとき（はじめから決めてある）は、印へフォーカスを移さない
  it('leaves the focus alone when the image was chosen before', async () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    render(<CardAndRow initial="favorite" />);

    expect(screen.getAllByText('この画像に決めた（お気に入り）')).toHaveLength(2);
    await expectFocusStaysOn(elsewhere);
    elsewhere.remove();
  });

  // ここで決めたあとに外し、別の所で決め直しても、ここの印はフォーカスを奪わない
  it('does not take the focus again once the choice was taken away and made elsewhere', async () => {
    savesTheSelection();
    const user = userEvent.setup();
    render(<CardAndRow />);
    screen.getAllByRole('button', { name: CHOOSE })[0]!.focus();
    await user.keyboard('{Enter}');

    act(() => setVerdict(null));
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    act(() => setVerdict('favorite'));

    expect(screen.getAllByText('この画像に決めた（お気に入り）')).toHaveLength(2);
    await expectFocusStaysOn(elsewhere);
    elsewhere.remove();
  });
});
