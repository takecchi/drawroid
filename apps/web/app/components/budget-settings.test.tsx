// @vitest-environment jsdom
import { ApiError, type BudgetSettingsResponse } from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BudgetInvalidNotice, BudgetSettings } from './budget-settings';

const mocks = vi.hoisted(() => ({
  saveBudgetSettings: vi.fn(),
  useBudgetSettings: vi.fn(),
}));

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  saveBudgetSettings: mocks.saveBudgetSettings,
  useBudgetSettings: mocks.useBudgetSettings,
}));

afterEach(cleanup);

const defaults = {
  text: { intent: 600, prompt: 600 },
  imageLongEdge: 512,
  memory: { think: { maxCount: 8, maxSize: 400 } },
};
const stored = {
  overrides: {},
  effective: defaults,
  defaults,
  invalid: [],
} as unknown as BudgetSettingsResponse;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useBudgetSettings.mockReturnValue({ data: stored, error: undefined });
  mocks.saveBudgetSettings.mockResolvedValue(stored);
});

// 欄の名前は「日本語の説明（内部名）」。内部名で指す
const input = (path: string) =>
  screen.getByLabelText<HTMLInputElement>((name) => name.endsWith(`（${path}）`));
const saveButton = () => screen.getByRole('button', { name: '予算を保存' });

describe('BudgetSettings', () => {
  it('shows an empty field for every number of the defaults, with the default as the placeholder', () => {
    render(<BudgetSettings />);

    expect(input('imageLongEdge').value).toBe('');
    expect(input('imageLongEdge').placeholder).toBe('512');
    expect(input('text.prompt').placeholder).toBe('600');
    expect(input('memory.think.maxCount').placeholder).toBe('8');
  });

  it('shows the written values in their fields', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: { ...stored, overrides: { imageLongEdge: 256, memory: { think: { maxCount: 2 } } } },
      error: undefined,
    });
    render(<BudgetSettings />);

    expect(input('imageLongEdge').value).toBe('256');
    expect(input('memory.think.maxCount').value).toBe('2');
    expect(input('text.prompt').value).toBe('');
  });

  it('saves only the fields that were filled in', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);

    await user.type(input('imageLongEdge'), '256');
    await user.type(input('memory.think.maxCount'), '2');
    await user.click(saveButton());

    expect(mocks.saveBudgetSettings).toHaveBeenCalledWith({
      imageLongEdge: 256,
      memory: { think: { maxCount: 2 } },
    });
  });

  it('refuses a value that is not an integer or is below 1, saying why, without saving', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);

    await user.type(input('imageLongEdge'), '2.5');
    await user.type(input('text.prompt'), '0');
    await user.click(saveButton());

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('imageLongEdge: 整数で入れる');
    expect(alert).toContain('text.prompt: 1 以上で入れる');
    expect(mocks.saveBudgetSettings).not.toHaveBeenCalled();
  });

  it('shows the reason of the API when it refuses a value, and keeps what was typed', async () => {
    const user = userEvent.setup();
    mocks.saveBudgetSettings.mockRejectedValue(
      new ApiError('invalid_request', 'imageLongEdge: 128 以上で入れる', 400),
    );
    render(<BudgetSettings />);

    await user.type(input('imageLongEdge'), '64');
    await user.click(saveButton());

    expect((await screen.findByRole('alert')).textContent).toContain(
      'imageLongEdge: 128 以上で入れる',
    );
    expect(input('imageLongEdge').value).toBe('64');
  });

  it('says the stored budgets cannot be read', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: undefined,
      error: new ApiError('invalid_config', 'config.json の budgets が不正', 500),
    });
    render(<BudgetSettings />);

    expect(screen.getByRole('alert').textContent).toContain('config.json の budgets が不正');
  });
});

describe('BudgetInvalidNotice', () => {
  it('shows nothing when every field of budgets was read', () => {
    const { container } = render(<BudgetInvalidNotice />);

    expect(container.textContent).toBe('');
  });

  it('names each field that went back to the default, with the reason', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: {
        ...stored,
        invalid: [
          { path: 'text.prompt', reason: '1 以上にする' },
          { path: 'text.unknownField', reason: '知らない欄' },
        ],
      },
      error: undefined,
    });
    render(<BudgetInvalidNotice />);

    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('既定の値に戻して動いている');
    const items = within(notice)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'プロンプトの文字数（text.prompt）: 1 以上にする',
      'text.unknownField: 知らない欄',
    ]);
  });

  it('says the whole budgets could not be read', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: { ...stored, invalid: [{ path: '*', reason: '予算が、欄の集まりになっていない' }] },
      error: undefined,
    });
    render(<BudgetInvalidNotice />);

    expect(screen.getByRole('listitem').textContent).toBe(
      '予算の全体: 予算が、欄の集まりになっていない',
    );
  });

  it('marks the field in the form that went back to the default', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: { ...stored, invalid: [{ path: 'text.prompt', reason: '1 以上にする' }] },
      error: undefined,
    });
    render(<BudgetSettings />);

    expect(
      screen.getByText('config.json の値が読めず、既定の値に戻している: 1 以上にする'),
    ).toBeTruthy();
    expect(screen.getAllByText(/既定の値に戻している/)).toHaveLength(1);
  });

  it('gives each marked field its own reason', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: {
        ...stored,
        invalid: [
          { path: 'text.prompt', reason: '1 以上にする' },
          { path: 'imageLongEdge', reason: '整数にする' },
        ],
      },
      error: undefined,
    });
    render(<BudgetSettings />);

    // 欄の添え書きは、その欄の label のすぐ後ろにある
    const noteOf = (path: string) =>
      input(path).closest('label')?.nextElementSibling?.textContent ?? null;
    expect(noteOf('text.prompt')).toBe(
      'config.json の値が読めず、既定の値に戻している: 1 以上にする',
    );
    expect(noteOf('imageLongEdge')).toBe(
      'config.json の値が読めず、既定の値に戻している: 整数にする',
    );
    expect(noteOf('text.intent')).toBeNull();
  });
});
