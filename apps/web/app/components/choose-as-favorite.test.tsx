// @vitest-environment jsdom
import type { SelectionVerdict } from '@drawroid/core';
import { recheckJobDistill, setSelection } from '@drawroid/swr';
import { act, cleanup, render, screen } from '@testing-library/react';
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
    expect(document.activeElement).toBe(card.querySelector('p'));
  });

  // 開き直したとき（はじめから決めてある）は、印へフォーカスを移さない
  it('leaves the focus alone when the image was chosen before', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    render(<CardAndRow initial="favorite" />);

    expect(screen.getAllByText('この画像に決めた（お気に入り）')).toHaveLength(2);
    expect(document.activeElement).toBe(elsewhere);
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
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
