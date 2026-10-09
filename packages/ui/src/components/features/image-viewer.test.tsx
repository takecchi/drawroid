// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ImageCard } from './record';
import { ImageViewer, type ViewerImage } from './image-viewer';

afterEach(cleanup);

// 2 回ぶん（1回目に2枚、2回目に1枚）
const IMAGES: ViewerImage[] = [
  {
    key: '1-0',
    src: '/a.png',
    fullSrc: '/a.png',
    title: '1 回目の画像 1 番',
    alt: '1 回目の画像 1 番',
  },
  {
    key: '1-1',
    src: '/b.png',
    fullSrc: '/b.png',
    title: '1 回目の画像 2 番',
    alt: '1 回目の画像 2 番',
  },
  {
    key: '2-0',
    src: '/c.png',
    fullSrc: '/c.png',
    title: '2 回目の画像 1 番',
    alt: '2 回目の画像 1 番',
  },
];

function Gallery() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {IMAGES.map((image) => (
        <ImageCard
          key={image.key}
          href={image.fullSrc}
          src={image.src}
          alt={image.alt}
          viewerKey={image.key}
          onOpen={() => setOpen(image.key)}
        />
      ))}
      <ImageViewer images={IMAGES} openKey={open} onOpenKeyChange={setOpen} />
    </>
  );
}

describe('ImageViewer', () => {
  it('opens the pressed image large, named after it', async () => {
    const user = userEvent.setup();
    render(<Gallery />);

    await user.click(screen.getByRole('button', { name: '大きく見る: 1 回目の画像 2 番' }));

    const dialog = screen.getByRole('dialog', { name: /1 回目の画像 2 番/ });
    expect(dialog.textContent).toContain('3 枚中 2 枚目');
    expect(screen.getAllByAltText('1 回目の画像 2 番').some((img) => dialog.contains(img))).toBe(
      true,
    );
  });

  it('moves with the arrow keys within an iteration and on to the next one, stopping at the ends', async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    await user.click(screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番' }));
    expect(screen.getByRole('button', { name: '前の画像' })).toHaveProperty('disabled', true);

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: /1 回目の画像 2 番/ })).toBeTruthy();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: /2 回目の画像 1 番/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '次の画像' })).toHaveProperty('disabled', true);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: /2 回目の画像 1 番/ })).toBeTruthy();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: /1 回目の画像 2 番/ })).toBeTruthy();
  });

  it('closes on Escape and puts the focus back on the thumbnail of the image last viewed', async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    await user.click(screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番' }));
    await user.keyboard('{ArrowRight}{ArrowRight}');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '大きく見る: 2 回目の画像 1 番' }),
    );
  });

  it('closes with the close button, which has a Japanese name', async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    await user.click(screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番' }));

    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番' }),
    );
  });

  it('keeps moving with the arrow keys after a button in the view was pressed and took the focus away', async () => {
    const user = userEvent.setup();
    function WithDetails() {
      const [open, setOpen] = useState<string | null>('1-0');
      const [pressed, setPressed] = useState(false);
      return (
        <ImageViewer
          images={IMAGES}
          openKey={open}
          onOpenKeyChange={setOpen}
          details={() => (
            // 押すと押せなくなる（送っている間のボタンと同じ）: 焦点は窓の外へ落ちる
            <button type="button" disabled={pressed} onClick={() => setPressed(true)}>
              お気に入り
            </button>
          )}
        />
      );
    }
    render(<WithDetails />);

    await user.click(screen.getByRole('button', { name: 'お気に入り' }));
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('dialog', { name: /1 回目の画像 2 番/ })).toBeTruthy();
  });

  it('leaves the arrow keys to a text field in the view, to move between its letters', async () => {
    const user = userEvent.setup();
    function WithField() {
      const [open, setOpen] = useState<string | null>('1-0');
      return (
        <ImageViewer
          images={IMAGES}
          openKey={open}
          onOpenKeyChange={setOpen}
          details={() => <input aria-label="ひとこと" defaultValue="夕焼け" />}
        />
      );
    }
    render(<WithField />);

    await user.click(screen.getByRole('textbox', { name: 'ひとこと' }));
    await user.keyboard('{ArrowLeft}{ArrowRight}');

    expect(screen.getByRole('dialog', { name: /1 回目の画像 1 番/ })).toBeTruthy();
  });

  describe('swiping on a narrow screen', () => {
    function openAt(key: string) {
      function Opened() {
        const [open, setOpen] = useState<string | null>(key);
        return <ImageViewer images={IMAGES} openKey={open} onOpenKeyChange={setOpen} />;
      }
      render(<Opened />);
      const image = screen.getByRole('dialog').querySelector('img');
      if (image?.parentElement == null) throw new Error('画像が無い');
      return image.parentElement;
    }
    const swipe = (area: HTMLElement, dx: number, dy: number) => {
      fireEvent.pointerDown(area, { clientX: 200, clientY: 200 });
      fireEvent.pointerUp(area, { clientX: 200 + dx, clientY: 200 + dy });
    };

    it('moves to the next image when swiped to the left, and back when swiped to the right', () => {
      const area = openAt('1-1');

      swipe(area, -120, 10);
      expect(screen.getByRole('dialog', { name: /2 回目の画像 1 番/ })).toBeTruthy();

      swipe(area, 120, -10);
      expect(screen.getByRole('dialog', { name: /1 回目の画像 2 番/ })).toBeTruthy();
    });

    it('does not move for a short slide, nor for a slide that is more up and down than sideways', () => {
      const area = openAt('1-1');

      swipe(area, -20, 0);
      swipe(area, -60, 140);

      expect(screen.getByRole('dialog', { name: /1 回目の画像 2 番/ })).toBeTruthy();
    });
  });
});
