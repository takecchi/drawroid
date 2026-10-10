// @vitest-environment jsdom
import { ApiError } from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidateNotes } from './candidate-notes';

const mocks = vi.hoisted(() => ({
  useCandidateNotes: vi.fn(),
  saveCandidateNotes: vi.fn(),
  useCandidates: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  ...mocks,
}));

afterEach(cleanup);

const lists: Record<string, { name: string }[]> = {
  checkpoint: [{ name: 'anime.safetensors' }],
  lora: [{ name: 'detail.safetensors' }, { name: 'style.safetensors' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useCandidateNotes.mockReturnValue({
    data: { notes: { 'detail.safetensors': '細部を足す', 'gone.safetensors': '消えた候補' } },
    error: undefined,
  });
  mocks.saveCandidateNotes.mockImplementation(async (notes: Record<string, string>) => ({ notes }));
  mocks.useCandidates.mockImplementation((kind: string) => ({
    data: { candidates: lists[kind] ?? [] },
    error: undefined,
  }));
});

const noteOf = (name: string) => screen.getByLabelText<HTMLInputElement>(`${name} の説明`);
const save = () => userEvent.click(screen.getByRole('button', { name: '説明を保存' }));

describe('CandidateNotes', () => {
  it('shows the candidates of each kind with the note written for them', () => {
    render(<CandidateNotes />);

    const loras = within(screen.getByRole('region', { name: 'LoRA' }));
    expect(loras.getByLabelText<HTMLInputElement>('detail.safetensors の説明').value).toBe(
      '細部を足す',
    );
    expect(loras.getByLabelText<HTMLInputElement>('style.safetensors の説明').value).toBe('');
    expect(
      within(screen.getByRole('region', { name: 'checkpoint' })).getByLabelText(
        'anime.safetensors の説明',
      ),
    ).toBeTruthy();
  });

  it('saves all the notes, with a new one added and an emptied one left out', async () => {
    render(<CandidateNotes />);

    await userEvent.type(noteOf('style.safetensors'), '線を太く');
    await userEvent.clear(noteOf('detail.safetensors'));
    await save();

    expect(mocks.saveCandidateNotes).toHaveBeenCalledWith({
      'style.safetensors': '線を太く',
      'gone.safetensors': '消えた候補',
    });
  });

  // 押した保存は送っている間押せなくなるので、フォーカスは保存した知らせへ移る。欄を触らない2回目の保存でも移る
  it('moves the focus to the note that it saved, also on a second save', async () => {
    render(<CandidateNotes />);
    const SAVED = '保存した。次のジョブから考える役に渡る。';

    await save();
    const first = await screen.findByText(SAVED);
    expect(first.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(first);

    screen.getByRole('button', { name: '説明を保存' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '説明を保存' }));
    await save();

    const second = await screen.findByText(SAVED);
    expect(document.activeElement).toBe(second);
  });

  it('keeps notes for candidates the backend no longer has, until they are removed', async () => {
    render(<CandidateNotes />);

    const orphans = within(screen.getByRole('region', { name: '今の候補に無い説明' }));
    expect(orphans.getByText('消えた候補')).toBeTruthy();
    expect(orphans.queryByText('detail.safetensors')).toBeNull();
    await userEvent.click(orphans.getByRole('button', { name: 'gone.safetensors の説明を消す' }));
    await save();

    expect(mocks.saveCandidateNotes).toHaveBeenCalledWith({
      'detail.safetensors': '細部を足す',
    });
  });

  // 指で押せる 44px にする（広い画面をマウスで操作するときだけ詰める）。実際の大きさは、ブラウザで測る
  it('makes the button that clears a note 44px tall on a narrow screen', () => {
    render(<CandidateNotes />);

    expect(
      screen.getByRole('button', { name: 'gone.safetensors の説明を消す' }).className.split(' '),
    ).toEqual(expect.arrayContaining(['h-11', 'md:pointer-fine:h-7']));
  });

  it('narrows the candidates by a part of their names', async () => {
    render(<CandidateNotes />);

    await userEvent.type(screen.getByLabelText('名前で絞る'), 'STYLE');

    expect(screen.queryByLabelText('detail.safetensors の説明')).toBeNull();
    expect(noteOf('style.safetensors')).toBeTruthy();
  });

  it('does not save a note that is too long, and says which one it was', async () => {
    render(<CandidateNotes />);

    await userEvent.click(noteOf('style.safetensors'));
    await userEvent.paste('あ'.repeat(201));
    await save();

    expect(mocks.saveCandidateNotes).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(
      'style.safetensors: 説明は 200 文字まで',
    );
  });

  it('shows why the API refused the notes', async () => {
    mocks.saveCandidateNotes.mockRejectedValue(
      new ApiError('invalid_request', '説明は 5000 件まで', 400),
    );
    render(<CandidateNotes />);

    await save();

    expect((await screen.findByRole('alert')).textContent).toContain('説明は 5000 件まで');
  });

  it('says the notes file could not be read and that saving replaces it', () => {
    mocks.useCandidateNotes.mockReturnValue({
      data: { notes: {}, problem: 'JSON として読めない' },
      error: undefined,
    });
    render(<CandidateNotes />);

    const alert = screen.getByRole('alert').textContent;
    expect(alert).toContain('JSON として読めない');
    expect(alert).toContain('保存すると');
  });
});
