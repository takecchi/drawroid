// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationForm } from './generation-form';

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
  lora: [{ name: 'detail' }],
};

function backendIs(kind: 'forge' | 'a1111' | undefined) {
  mocks.useBackendSettings.mockReturnValue({
    data:
      kind === undefined ? undefined : { kind, url: 'http://127.0.0.1:7860', urlSource: 'default' },
    error: undefined,
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
  it('does not lean to either backend before it knows which one is chosen', () => {
    backendIs(undefined);
    render(<GenerationForm onStarted={() => {}} />);

    expect(defaultOf('checkpoint')).toBe('バックエンド（Forge / A1111）の既定');
  });

  it('starts a job with the chosen candidate and LoRA, and hands over its id', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    render(<GenerationForm onStarted={onStarted} />);

    await user.type(screen.getByLabelText('prompt'), 'a cat');
    await user.selectOptions(screen.getByLabelText('checkpoint'), 'anime.safetensors');
    await user.selectOptions(screen.getByLabelText('LoRA'), 'detail');
    await user.clear(screen.getByLabelText('LoRA の重み'));
    await user.type(screen.getByLabelText('LoRA の重み'), '0.6');
    await user.click(screen.getByRole('button', { name: '足す' }));
    await user.click(screen.getByRole('button', { name: '生成する' }));

    expect(mocks.startManualJob).toHaveBeenCalledWith({
      prompt: 'a cat',
      checkpoint: 'anime.safetensors',
      loras: [{ name: 'detail', weight: 0.6 }],
      steps: 20,
      cfgScale: 7,
      width: 512,
      height: 512,
      batchSize: 1,
    });
    expect(onStarted).toHaveBeenCalledWith('job-1');
  });
});
