// @vitest-environment jsdom
import { addMask, ApiError } from '@drawroid/swr';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeMaskPng } from '../lib/mask-png';
import { MaskPainter } from './mask-painter';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  addMask: vi.fn(),
}));
// jsdom には canvas の描画が無い: PNG にする所は差し替え、何を渡したかを見る
vi.mock('../lib/mask-png', () => ({ encodeMaskPng: vi.fn() }));

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
  render(
    <MaskPainter
      jobId="job-1"
      image={{ iteration: 2, index: 1, url: '/api/jobs/job-1/images/2-1.png' }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'マスクを塗る' }));
  const img = screen.getByAltText('2 回目の画像 1');
  Object.defineProperty(img, 'naturalWidth', { value: 1024 });
  Object.defineProperty(img, 'naturalHeight', { value: 768 });
  fireEvent.load(img);
  const canvas = screen.getByLabelText('マスクを塗る所');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 512, height: 384, right: 512, bottom: 384, x: 0, y: 0 }) as DOMRect;
  return { user, canvas };
}

function drag(canvas: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe('MaskPainter', () => {
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
});
