// @vitest-environment jsdom
import { ApiError } from '@drawroid/swr';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationForm } from './generation-form';

// 文が見えたすぐあとに確かめない: フォーカスを移すのは描いたあとの effect で、act の外で結果が届くと、
// findBy* が文を見つけた時点ではまだ走っていないことがある
const expectFocusMovesTo = (element: Element) =>
  waitFor(() => expect(document.activeElement).toBe(element));

const mocks = vi.hoisted(() => ({
  startManualJob: vi.fn(),
  useBackendSettings: vi.fn(),
  useCandidates: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  ...mocks,
}));

afterEach(cleanup);

const lists: Record<string, { name: string; label?: string }[]> = {
  checkpoint: [{ name: 'anime.safetensors', label: 'anime' }],
  vae: [{ name: 'clear.vae.pt' }],
  sampler: [{ name: 'Euler a' }],
  scheduler: [{ name: 'Karras' }],
  lora: [{ name: 'detail' }],
};

function backendIs(kind: 'forge' | 'a1111' | undefined, error?: Error) {
  mocks.useBackendSettings.mockReturnValue({
    data:
      kind === undefined ? undefined : { kind, url: 'http://127.0.0.1:7860', urlSource: 'default' },
    error,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useCandidates.mockImplementation((kind: string) => ({
    data: { candidates: lists[kind] ?? [] },
    error: undefined,
  }));
  mocks.startManualJob.mockResolvedValue({ jobId: 'job-1' });
  backendIs('forge');
});

const defaultOf = (label: string) =>
  screen.getByLabelText<HTMLSelectElement>(label).querySelector('option[value=""]')?.textContent;

describe('GenerationForm', () => {
  it('names the backend that was chosen as the one whose default is used', () => {
    backendIs('a1111');
    render(<GenerationForm onStarted={() => {}} />);

    for (const label of ['checkpoint', 'vae', 'sampler', 'scheduler']) {
      expect(defaultOf(label)).toBe('A1111 の既定');
    }
  });

  it('names Forge when Forge is the backend', () => {
    render(<GenerationForm onStarted={() => {}} />);

    expect(defaultOf('checkpoint')).toBe('Forge の既定');
  });

  // 読み込み中に「Forge」と出すと、A1111 を選んだ人には違う名前が一瞬見える
  // 設定が読めなかったとき（バックエンドの設定の API が落ちている）も、種類は分からないので同じ
  it.each([
    ['while the backend settings are loading', undefined],
    ['when the backend settings could not be read', new Error('読めない')],
  ])('does not lean to either backend before it knows which one is chosen, %s', (_, error) => {
    backendIs(undefined, error);
    render(<GenerationForm onStarted={() => {}} />);

    for (const label of ['checkpoint', 'vae', 'sampler', 'scheduler']) {
      expect(defaultOf(label)).toBe('バックエンド（Forge / A1111）の既定');
      // 寄せないだけで、選べなくはしない
      expect(screen.getByLabelText<HTMLSelectElement>(label).disabled).toBe(false);
    }
  });

  it('starts a job with the chosen candidates and LoRA, and hands over its id', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    render(<GenerationForm onStarted={onStarted} />);

    await user.type(screen.getByLabelText('prompt'), 'a cat');
    await user.selectOptions(screen.getByLabelText('checkpoint'), 'anime.safetensors');
    await user.selectOptions(screen.getByLabelText('vae'), 'clear.vae.pt');
    await user.selectOptions(screen.getByLabelText('sampler'), 'Euler a');
    await user.selectOptions(screen.getByLabelText('scheduler'), 'Karras');
    await user.selectOptions(screen.getByLabelText('LoRA'), 'detail');
    await user.clear(screen.getByLabelText('LoRA の重み'));
    await user.type(screen.getByLabelText('LoRA の重み'), '0.6');
    await user.click(screen.getByRole('button', { name: '足す' }));
    await user.click(screen.getByRole('button', { name: '生成する' }));

    expect(mocks.startManualJob).toHaveBeenCalledWith({
      prompt: 'a cat',
      checkpoint: 'anime.safetensors',
      vae: 'clear.vae.pt',
      sampler: 'Euler a',
      scheduler: 'Karras',
      loras: [{ name: 'detail', weight: 0.6 }],
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
      batchSize: 1,
    });
    expect(onStarted).toHaveBeenCalledWith('job-1');
  });

  // 「選ぶ」のままのときと同じ形で断る。バックエンドが空白だけの名前の候補を返しても足せない
  it.each([
    ['nothing is chosen', ''],
    ['the chosen name is only spaces', '  '],
  ])('does not let a LoRA be added while %s', async (_, name) => {
    const loras = [{ name: '  ', label: '（空白の名前）' }, { name: 'detail' }];
    mocks.useCandidates.mockImplementation((kind: string) => ({
      data: { candidates: kind === 'lora' ? loras : (lists[kind] ?? []) },
      error: undefined,
    }));
    const user = userEvent.setup();
    render(<GenerationForm onStarted={() => {}} />);

    await user.selectOptions(screen.getByLabelText('LoRA'), name);
    await user.click(screen.getByRole('button', { name: '足す' }));

    expect(screen.getByRole('button', { name: '足す' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '外す' })).toBeNull();
  });

  it('cannot be sent again while it is sending', async () => {
    mocks.startManualJob.mockReturnValue(new Promise(() => {}));
    render(<GenerationForm onStarted={() => {}} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '生成する' }));

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '生成する' }).disabled).toBe(true);
  });

  // 押した「生成する」は送っている間押せなくなるので、断られたらフォーカスは断りへ移る。2回続けて断られても移る
  it('moves the focus to the reason when the API refuses, also on a second refusal', async () => {
    const user = userEvent.setup();
    mocks.startManualJob.mockRejectedValue(
      new ApiError('invalid_request', 'steps: 数を入れる', 400),
    );
    render(<GenerationForm onStarted={() => {}} />);
    const button = () => screen.getByRole('button', { name: '生成する' });

    button().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));

    button().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.startManualJob).toHaveBeenCalledTimes(2));
    await expectFocusMovesTo(await screen.findByRole('alert'));
  });

  it('leaves the focus in a field being corrected after a refusal', async () => {
    const user = userEvent.setup();
    mocks.startManualJob.mockRejectedValue(
      new ApiError('invalid_request', 'steps: 数を入れる', 400),
    );
    render(<GenerationForm onStarted={() => {}} />);
    await user.click(screen.getByRole('button', { name: '生成する' }));
    await expectFocusMovesTo(await screen.findByRole('alert'));

    const steps = screen.getByLabelText('steps');
    await user.clear(steps);
    await user.type(steps, '30');

    expect(document.activeElement).toBe(steps);
  });

  // 指で押せる 44px にする（広い画面をマウスで操作するときだけ詰める）。実際の大きさは、ブラウザで測る
  it('makes the button that drops a LoRA 44px tall on a narrow screen', async () => {
    const user = userEvent.setup();
    render(<GenerationForm onStarted={() => {}} />);
    await user.selectOptions(screen.getByLabelText('LoRA'), 'detail');
    await user.click(screen.getByRole('button', { name: '足す' }));

    expect(screen.getByRole('button', { name: '外す' }).className.split(' ')).toEqual(
      expect.arrayContaining(['h-11', 'md:pointer-fine:h-7']),
    );
  });
});
