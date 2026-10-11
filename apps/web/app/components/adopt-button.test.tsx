// @vitest-environment jsdom
import { adoptImage, ApiError } from '@drawroid/swr';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdoptButton } from './adopt-button';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  adoptImage: vi.fn(),
}));

const JOB = '20261009-153112-k3f9';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// 文が見えたすぐあとに確かめない: フォーカスを移すのは描いたあとの effect で、act の外で結果が届くと、
// findBy* が文を見つけた時点ではまだ走っていないことがある
const expectFocusMovesTo = (element: Element) =>
  waitFor(() => expect(document.activeElement).toBe(element));

// 移さないことは、すぐに確かめるだけでは、遅れて移す形を見逃す。しばらく待ってからもう一度確かめる
const expectFocusStaysOn = async (element: Element) => {
  expect(document.activeElement).toBe(element);
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(document.activeElement).toBe(element);
};

function renderButton() {
  render(
    <AdoptButton jobId={JOB} image={{ iteration: 2, index: 0 }} imageLabel="2 回目の画像 1 番" />,
  );
  return userEvent.setup();
}

describe('AdoptButton', () => {
  it('asks once before taking the image, then takes it through the adopt API and says it was chosen', async () => {
    vi.mocked(adoptImage).mockResolvedValue({ adopted: { iteration: 2, index: 0 } });
    const user = renderButton();

    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));
    expect(adoptImage).not.toHaveBeenCalled();
    expect(screen.getByText(/2 回目の画像 1 番に決める？/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' }));

    expect(adoptImage).toHaveBeenCalledExactlyOnceWith(JOB, { iteration: 2, index: 0 });
    expect(await screen.findByText('この画像に決めた')).toBeTruthy();
  });

  it('takes nothing when the person changes their mind', async () => {
    const user = renderButton();

    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));
    await user.click(screen.getByRole('button', { name: 'やめる' }));

    expect(adoptImage).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }),
    ).toBeTruthy();
  });

  // 確かめは窓ではなくその場に出るが、窓と同じく Escape で閉じる。フォーカスは選ぶボタンへ戻る
  it('takes nothing and goes back to choosing when Escape is pressed while asking', async () => {
    const user = renderButton();
    const choose = () =>
      screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' });

    choose().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');

    expect(adoptImage).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: '2 回目の画像 1 番に決めるかの確かめ' })).toBeNull();
    expect(document.activeElement).toBe(choose());
  });

  // 送ったあとは取り消せないので、Escape で「やめた」ように見せない
  it('keeps saying it is deciding when Escape is pressed after sending', async () => {
    vi.mocked(adoptImage).mockReturnValue(new Promise(() => undefined));
    const user = renderButton();

    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));
    await user.click(screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' }));
    // 送っている間はボタンが押せず、確かめの中にフォーカスが無いことがあるので、確かめそのものに送る
    const asking = screen.getByRole('group', { name: '2 回目の画像 1 番に決めるかの確かめ' });
    fireEvent.keyDown(asking, { key: 'Escape' });

    expect(screen.getByRole('group', { name: '2 回目の画像 1 番に決めるかの確かめ' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }),
    ).toBeNull();
  });

  // 送ったあとは取り消せず、二度は送らない
  it('lets neither deciding nor changing the mind be pressed while sending', async () => {
    vi.mocked(adoptImage).mockReturnValue(new Promise(() => undefined));
    const user = renderButton();

    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));
    await user.click(screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' }));

    expect(screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'やめる' })).toHaveProperty('disabled', true);
  });

  it('says the image was chosen when the record says so, without being pressed (as after reopening)', () => {
    render(
      <AdoptButton
        jobId={JOB}
        image={{ iteration: 2, index: 0 }}
        imageLabel="2 回目の画像 1 番"
        chosen
      />,
    );

    expect(screen.getByText('この画像に決めた')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows why the image could not be taken, and lets the person try again', async () => {
    vi.mocked(adoptImage).mockRejectedValue(
      new ApiError('conflict', '絵がもう止まっていて、画像 2-0 を採れなかった', 409),
    );
    const user = renderButton();

    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));
    await user.click(screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' }));

    expect(
      await screen.findByText('決められない: 絵がもう止まっていて、画像 2-0 を採れなかった'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }),
    ).toBeTruthy();
  });

  // 読み上げに聞こえるよう role=alert で出す。文は変えない。フォーカスは断りへは移さない:
  // 送っていた確かめのボタンは消え、替わった先の「この画像に決める」（押せる）へ移るので、そのまま押し直せる
  it('says why the image could not be taken as an alert, leaving the focus on choosing again', async () => {
    vi.mocked(adoptImage).mockRejectedValue(new ApiError('conflict', '採れなかった', 409));
    const user = renderButton();
    const choose = () =>
      screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' });

    choose().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect((await screen.findByRole('alert')).textContent).toBe('決められない: 採れなかった');
    await expectFocusMovesTo(choose());
    await expectFocusStaysOn(choose());
  });

  // 押したボタンは次の形に替わって消える。フォーカスは、替わった先の最初のボタン・決めた印へ移る
  it('moves the focus along as the person decides: to deciding, back to choosing, then to the mark', async () => {
    vi.mocked(adoptImage).mockResolvedValue({ adopted: { iteration: 2, index: 0 } });
    const user = renderButton();
    const choose = () =>
      screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' });

    choose().focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' }),
    );

    screen.getByRole('button', { name: 'やめる' }).focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(choose());

    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByText('この画像に決めた'));
  });

  it('moves the focus back to choosing when the image could not be taken', async () => {
    vi.mocked(adoptImage).mockRejectedValue(new ApiError('conflict', '採れなかった', 409));
    const user = renderButton();

    screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    await screen.findByText('決められない: 採れなかった');
    await expectFocusMovesTo(
      screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }),
    );
  });

  // 押していないのに決まった（開き直した・会話で決まった）ときは、印へフォーカスを移さない
  it('leaves the focus alone when the image was chosen without being pressed here', async () => {
    const props = {
      jobId: JOB,
      image: { iteration: 2, index: 0 },
      imageLabel: '2 回目の画像 1 番',
    };
    const { rerender } = render(<AdoptButton {...props} />);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    rerender(<AdoptButton {...props} chosen />);

    expect(screen.getByText('この画像に決めた')).toBeTruthy();
    await expectFocusStaysOn(elsewhere);
    elsewhere.remove();
  });

  // 確かめの段のボタンも指で押せる 44px にする（広い画面をマウスで操作するときだけ詰める）。実際の大きさは、ブラウザで測る
  it('makes the buttons of the asking step 44px tall on a narrow screen', async () => {
    const user = renderButton();
    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));

    for (const name of ['決める: 2 回目の画像 1 番', 'やめる']) {
      expect(screen.getByRole('button', { name }).className.split(' ')).toEqual(
        expect.arrayContaining(['h-11', 'md:pointer-fine:h-7']),
      );
    }
  });

  // 画像の行が新しく出ただけ（描いている途中に画像が増えた）では、フォーカスを奪わない
  it('does not take the focus when it appears', async () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    renderButton();

    await expectFocusStaysOn(elsewhere);
    elsewhere.remove();
  });

  // 移すのは形が替わったときの一度だけ: 会話が流れて描き直されるたびに取り戻すと、ほかの所を触っている人から奪うため
  it.each([
    ['choosing again after the person changed their mind', false],
    ['the mark after the image was decided', true],
  ])('does not take the focus back to %s when it is drawn again', async (_, decide) => {
    vi.mocked(adoptImage).mockResolvedValue({ adopted: { iteration: 2, index: 0 } });
    const props = { jobId: JOB, image: { iteration: 2, index: 0 } };
    const { rerender } = render(<AdoptButton {...props} imageLabel="2 回目の画像 1 番" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }));
    // 形が替わったときの一度の移しを待ってから、ほかの所へ移る: 待たないと、遅れて届いた一度目を取り戻したと読んでしまう
    if (decide) {
      await user.click(screen.getByRole('button', { name: '決める: 2 回目の画像 1 番' }));
      await expectFocusMovesTo(await screen.findByText('この画像に決めた'));
    } else {
      await user.click(screen.getByRole('button', { name: 'やめる' }));
      await expectFocusMovesTo(
        screen.getByRole('button', { name: 'この画像に決める: 2 回目の画像 1 番' }),
      );
    }
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    rerender(<AdoptButton {...props} imageLabel="2 回目の画像 1 番" />);

    await expectFocusStaysOn(elsewhere);
    elsewhere.remove();
  });
});
