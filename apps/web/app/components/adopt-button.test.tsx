// @vitest-environment jsdom
import { adoptImage, ApiError } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
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
});
