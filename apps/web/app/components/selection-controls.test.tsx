// @vitest-environment jsdom
import { setSelection } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelectionControls } from './selection-controls';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  setSelection: vi.fn(),
}));

const select = vi.mocked(setSelection);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderControls(verdict: 'favorite' | 'rejected' | null) {
  render(<SelectionControls jobId="job-1" imageKey="1-0" verdict={verdict} />);
  return userEvent.setup();
}

describe('SelectionControls', () => {
  it.each([
    ['favorite', 'お気に入り'],
    ['rejected', '却下'],
    [null, '未選択'],
  ] as const)('shows the current state when the verdict is %s', (verdict, label) => {
    renderControls(verdict);

    expect(screen.getByText(`今の状態: ${label}`)).toBeTruthy();
  });

  it('marks the image as a favorite', async () => {
    select.mockResolvedValue({} as Awaited<ReturnType<typeof setSelection>>);
    const user = renderControls(null);

    await user.click(screen.getByRole('button', { name: 'お気に入り' }));

    expect(select).toHaveBeenCalledWith('job-1', '1-0', 'favorite');
  });

  it('rejects the image', async () => {
    select.mockResolvedValue({} as Awaited<ReturnType<typeof setSelection>>);
    const user = renderControls('favorite');

    await user.click(screen.getByRole('button', { name: '却下' }));

    expect(select).toHaveBeenCalledWith('job-1', '1-0', 'rejected');
  });

  it('clears the verdict with a null verdict', async () => {
    select.mockResolvedValue({} as Awaited<ReturnType<typeof setSelection>>);
    const user = renderControls('rejected');

    await user.click(screen.getByRole('button', { name: '外す' }));

    expect(select).toHaveBeenCalledWith('job-1', '1-0', null);
  });

  it('disables the button for the state the image is already in', () => {
    renderControls('favorite');

    expect(screen.getByRole('button', { name: 'お気に入り' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '却下' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: '外す' })).toHaveProperty('disabled', false);
  });

  it('cannot clear a verdict on an image that has none', () => {
    renderControls(null);

    expect(screen.getByRole('button', { name: '外す' })).toHaveProperty('disabled', true);
  });

  it('shows the reason when the selection cannot be saved', async () => {
    const { ApiError } = await vi.importActual<typeof import('@drawroid/swr')>('@drawroid/swr');
    select.mockRejectedValue(new ApiError('not_found', '画像が無い', 404));
    const user = renderControls(null);

    await user.click(screen.getByRole('button', { name: '却下' }));

    expect((await screen.findByText(/選べない/)).textContent).toContain('画像が無い');
  });
});
