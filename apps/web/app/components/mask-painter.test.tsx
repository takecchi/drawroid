// @vitest-environment jsdom
import { addMask, ApiError } from '@drawroid/swr';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeMaskPng, MAX_MASK_BYTES } from '../lib/mask-png';
import { MaskPainter } from './mask-painter';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  addMask: vi.fn(),
}));
// jsdom には canvas の描画が無い: PNG にする所は差し替え、何を渡したかを見る
vi.mock('../lib/mask-png', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mask-png')>()),
  encodeMaskPng: vi.fn(),
}));

// 文が見えたすぐあとに確かめない: フォーカスを移すのは描いたあとの effect で、act の外で結果が届くと、
// findBy* が文を見つけた時点ではまだ走っていないことがある
const expectFocusMovesTo = (element: Element) =>
  waitFor(() => expect(document.activeElement).toBe(element));

const send = vi.mocked(addMask);
const encode = vi.mocked(encodeMaskPng);

beforeEach(() => {
  encode.mockResolvedValue('PNG-BASE64');
  send.mockResolvedValue({} as Awaited<ReturnType<typeof addMask>>);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// 元は 1024×768 の画像を、画面には 512×384 で出している
async function openPainter() {
  const user = userEvent.setup();
  const { rerender } = render(
    <MaskPainter
      jobId="job-1"
      image={{ iteration: 2, index: 1, url: '/api/jobs/job-1/images/2-1.png' }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'マスクを塗る' }));
  const img = screen.getByAltText('2 回目の画像 2 番');
  Object.defineProperty(img, 'naturalWidth', { value: 1024 });
  Object.defineProperty(img, 'naturalHeight', { value: 768 });
  fireEvent.load(img);
  const canvas = screen.getByLabelText('マスクを塗る所');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 512, height: 384, right: 512, bottom: 384, x: 0, y: 0 }) as DOMRect;
  return { user, canvas, rerender };
}

function drag(canvas: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe('MaskPainter', () => {
  // 指で塗る面は、なぞってもページが動かず、長押しでも選択や吹き出し（iOS）が出ない。jsdom は CSS を評価しないので class で見る
  it('keeps a finger on the surface for painting, not for scrolling, selecting or the long-press callout', async () => {
    const { canvas } = await openPainter();

    expect(canvas.className.split(' ')).toEqual(
      expect.arrayContaining(['touch-none', '[-webkit-touch-callout:none]']),
    );
  });

  // 塗る前の入り口と、塗る道具のボタン・欄も指で押せる 44px にする（広い画面をマウスで操作するときだけ詰める）。実際の大きさは、ブラウザで測る
  it('makes the buttons and the brush size field 44px tall on a narrow screen', async () => {
    render(
      <MaskPainter
        jobId="job-1"
        image={{ iteration: 2, index: 1, url: '/api/jobs/job-1/images/2-1.png' }}
      />,
    );
    const tall = ['h-11', 'md:pointer-fine:h-7'];
    const classesOf = (element: HTMLElement) => element.className.split(' ');
    expect(classesOf(screen.getByRole('button', { name: 'マスクを塗る' }))).toEqual(
      expect.arrayContaining(tall),
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'マスクを塗る' }));

    for (const name of ['ひとつ戻す', '全部消す', 'マスクを送る', '閉じる']) {
      expect(classesOf(screen.getByRole('button', { name }))).toEqual(expect.arrayContaining(tall));
    }
    expect(classesOf(screen.getByLabelText('筆の太さ（px）'))).toEqual(
      expect.arrayContaining(tall),
    );
  });

  // 押した「マスクを塗る」は消えるので、フォーカスは最初の道具へ移る。塗る面はキーボードでは塗れないことも、文で知らせる
  it('moves the focus to the brush size once painting starts, and says the keyboard cannot paint', async () => {
    const user = userEvent.setup();
    render(
      <MaskPainter
        jobId="job-1"
        image={{ iteration: 2, index: 1, url: '/api/jobs/job-1/images/2-1.png' }}
      />,
    );
    screen.getByRole('button', { name: 'マスクを塗る' }).focus();
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(screen.getByLabelText('筆の太さ（px）'));
    expect(screen.getByText('キーボードでは塗れない（マウス・タッチ・ペンで塗る）。')).toBeTruthy();
  });

  // 塗っている間に道具を使っても、フォーカスを筆の太さへ取り戻さない
  it('leaves the focus where the person moved it while painting', async () => {
    const { user, canvas } = await openPainter();

    await user.click(screen.getByLabelText('消しゴム'));
    drag(canvas, [10, 10], [50, 50]);

    // 塗った筆で道具が描き直されても、フォーカスは消しゴムのまま
    expect(screen.getByRole('button', { name: 'ひとつ戻す' })).toHaveProperty('disabled', false);
    expect(document.activeElement).toBe(screen.getByLabelText('消しゴム'));
  });

  it('names the first image of an iteration number 1, as the other views do', async () => {
    render(
      <MaskPainter
        jobId="job-1"
        image={{ iteration: 1, index: 0, url: '/api/jobs/job-1/images/1-0.png' }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'マスクを塗る' }));

    expect(screen.getByRole('img').getAttribute('alt')).toBe('1 回目の画像 1 番');
    expect(screen.queryByAltText(/画像 0/)).toBeNull();
  });

  it('sends what was painted as a mask of the original size, for the image it was painted on', async () => {
    const { user, canvas } = await openPainter();

    drag(canvas, [0, 0], [256, 192]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));

    expect(encode).toHaveBeenCalledWith(
      [
        {
          points: [
            { x: 0, y: 0 },
            { x: 512, y: 384 },
          ],
          radius: 32,
          erase: false,
        },
      ],
      { width: 1024, height: 768 },
    );
    expect(send).toHaveBeenCalledWith('job-1', { iteration: 2, index: 1 }, 'PNG-BASE64');
    expect(await screen.findByText(/送った/)).toBeTruthy();
  });

  it('does not send until something is painted', async () => {
    await openPainter();

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'マスクを送る' }).disabled).toBe(
      true,
    );
  });

  it('cannot send the same mask again while it is being sent', async () => {
    send.mockReturnValue(new Promise(() => undefined));
    const { user, canvas } = await openPainter();

    drag(canvas, [0, 0], [256, 192]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'マスクを送る' })).toHaveProperty('disabled', true);
  });

  it('empties what was painted once the mask is sent', async () => {
    const { user, canvas } = await openPainter();

    drag(canvas, [0, 0], [256, 192]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));
    await screen.findByText(/送った/);

    for (const name of ['ひとつ戻す', '全部消す', 'マスクを送る']) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
    }
  });

  // 別の画像の上に、前の画像の筆が残らない
  it('drops what was painted when the image to paint on changes', async () => {
    const { canvas, rerender } = await openPainter();
    drag(canvas, [0, 0], [256, 192]);
    expect(screen.getByRole('button', { name: '全部消す' })).toHaveProperty('disabled', false);

    rerender(
      <MaskPainter
        jobId="job-1"
        image={{ iteration: 2, index: 2, url: '/api/jobs/job-1/images/2-2.png' }}
      />,
    );

    expect(screen.getByRole('button', { name: '全部消す' })).toHaveProperty('disabled', true);
  });

  it('takes back the last stroke, and erases with the eraser at the chosen size', async () => {
    const { user, canvas } = await openPainter();

    drag(canvas, [0, 0], [10, 10]);
    drag(canvas, [20, 20], [30, 30]);
    await user.click(screen.getByRole('button', { name: 'ひとつ戻す' }));
    await user.click(screen.getByLabelText('消しゴム'));
    fireEvent.change(screen.getByLabelText('筆の太さ（px）'), { target: { value: '8' } });
    drag(canvas, [5, 5], [6, 6]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));

    const [strokes] = encode.mock.calls[0]!;
    expect(strokes.map(({ radius, erase }) => ({ radius, erase }))).toEqual([
      { radius: 32, erase: false },
      { radius: 8, erase: true },
    ]);
  });

  it('shows why the mask was refused and keeps what was painted', async () => {
    send.mockRejectedValue(new ApiError('conflict', 'ジョブはもう止まっている', 409));
    const { user, canvas } = await openPainter();

    drag(canvas, [0, 0], [10, 10]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));

    expect((await screen.findByRole('alert')).textContent).toContain('ジョブはもう止まっている');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'マスクを送る' }).disabled).toBe(
      false,
    );
  });

  // 押した「マスクを送る」は送っている間押せなくなるので、断られたらフォーカスは断りへ移る。2回続けて断られても移る
  it('moves the focus to the reason when the mask is refused, also on a second refusal', async () => {
    send.mockRejectedValue(new ApiError('conflict', 'ジョブはもう止まっている', 409));
    const { user, canvas } = await openPainter();
    drag(canvas, [0, 0], [10, 10]);
    const button = () => screen.getByRole('button', { name: 'マスクを送る' });

    button().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));

    button().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await expectFocusMovesTo(await screen.findByRole('alert'));
  });

  // 送ると塗りは空になり、押した「マスクを送る」も押せなくなる。フォーカスは成功の知らせへ移る。2回続けて送っても移る
  it('moves the focus to the note that the mask was sent, also on a second send', async () => {
    const { user, canvas } = await openPainter();
    drag(canvas, [0, 0], [10, 10]);
    const button = () => screen.getByRole('button', { name: 'マスクを送る' });

    button().focus();
    await user.keyboard('{Enter}');
    const first = await screen.findByRole('status');
    await expectFocusMovesTo(first);

    // 知らせのあとに筆の太さを直し始めても、フォーカスは奪われない
    const radius = screen.getByLabelText('筆の太さ（px）');
    await user.clear(radius);
    await user.type(radius, '8');
    expect(document.activeElement).toBe(radius);

    drag(canvas, [20, 20], [30, 30]);
    button().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const note = screen.getByRole('status');
      expect(note).not.toBe(first);
      expect(document.activeElement).toBe(note);
    });
  });

  it('moves the focus to the reason when the mask is refused before sending, also when pressed again', async () => {
    encode.mockResolvedValue(Buffer.from(new Uint8Array(MAX_MASK_BYTES + 1)).toString('base64'));
    const { user, canvas } = await openPainter();
    drag(canvas, [0, 0], [10, 10]);
    const button = () => screen.getByRole('button', { name: 'マスクを送る' });

    button().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));

    button().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(encode).toHaveBeenCalledTimes(2));
    await expectFocusMovesTo(await screen.findByRole('alert'));
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves the focus in the brush size being corrected after a refusal', async () => {
    send.mockRejectedValue(new ApiError('conflict', 'ジョブはもう止まっている', 409));
    const { user, canvas } = await openPainter();
    drag(canvas, [0, 0], [10, 10]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));
    await expectFocusMovesTo(await screen.findByRole('alert'));

    const radius = screen.getByLabelText('筆の太さ（px）');
    await user.clear(radius);
    await user.type(radius, '8');

    expect(document.activeElement).toBe(radius);
  });

  // 上限を超えたマスクは送らずに断る: 大きなマスクを送ってからサーバに断られると、待たされたうえに、何を直せばよいかが分からないため
  it('refuses a mask over the size limit before sending it, saying how to paint it smaller', async () => {
    encode.mockResolvedValue(Buffer.from(new Uint8Array(MAX_MASK_BYTES + 1)).toString('base64'));
    const { user, canvas } = await openPainter();

    drag(canvas, [0, 0], [10, 10]);
    await user.click(screen.getByRole('button', { name: 'マスクを送る' }));

    expect((await screen.findByRole('alert')).textContent).toContain('太い筆でまとめて塗り直す');
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'ひとつ戻す' }).disabled).toBe(
      false,
    );
  });
});
