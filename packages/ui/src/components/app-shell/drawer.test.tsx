// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Drawer } from './drawer';

afterEach(cleanup);

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        メニューを開く
      </button>
      <main>本文</main>
      <Drawer open={open} onClose={() => setOpen(false)} label="行き先">
        <a href="/memory">記憶</a>
      </Drawer>
    </>
  );
}

describe('Drawer', () => {
  it('moves the focus into itself when it opens, and hides the page behind it from what is read aloud', async () => {
    render(<Opener />);

    await userEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));

    const drawer = screen.getByRole('dialog', { name: '行き先' });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(screen.getByText('本文').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('closes on Escape and gives the focus back to the button that opened it', async () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'メニューを開く' });
    await userEvent.click(opener);

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
