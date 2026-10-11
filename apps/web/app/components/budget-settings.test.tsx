// @vitest-environment jsdom
import { describeInputOverflow, findInputOverflows, resolveBudgets } from '@drawroid/core';
import { ApiError, type BudgetSettingsResponse } from '@drawroid/swr';
import { Button } from '@drawroid/ui';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  candidates: { maxCount: 20, maxSize: 600 },
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

// 文が見えたすぐあとに確かめない: フォーカスを移すのは描いたあとの effect で、act の外で結果が届くと、
// findBy* が文を見つけた時点ではまだ走っていないことがある
const expectFocusMovesTo = (element: Element) =>
  waitFor(() => expect(document.activeElement).toBe(element));

describe('BudgetSettings', () => {
  // 保存しても欄の見た目は変わらないので、通ったことを出し、フォーカスをその知らせへ移す。欄を触ったら消す
  it('says it saved and moves the focus there, until the person edits a field again', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);
    const SAVED = '保存した。次に投入するジョブから効く。走っているジョブは変わらない。';
    expect(screen.queryByText(SAVED)).toBeNull();

    await user.type(input('imageLongEdge'), '256');
    saveButton().focus();
    await user.keyboard('{Enter}');

    await expectFocusMovesTo(await screen.findByText(SAVED));

    await user.type(input('imageLongEdge'), '0');
    expect(screen.queryByText(SAVED)).toBeNull();
  });

  it('moves the focus to the note again on a second save without editing', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);
    const SAVED = '保存した。次に投入するジョブから効く。走っているジョブは変わらない。';

    saveButton().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByText(SAVED));

    saveButton().focus();
    expect(document.activeElement).toBe(saveButton());
    await user.keyboard('{Enter}');

    await expectFocusMovesTo(await screen.findByText(SAVED));
  });

  // ほかの設定の区切りと同じ枠（Section のカード）に収める。見た目そのものは jsdom で測れないので、構造だけを見る
  it('keeps its heading, its fields and its save button in one card like the other settings', () => {
    render(<BudgetSettings />);

    const heading = screen.getByRole('heading', { level: 2, name: '予算の設定' });
    const card = heading.closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(card?.contains(input('imageLongEdge'))).toBe(true);
    expect(card?.contains(saveButton())).toBe(true);
  });

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
    expect(alert).toContain('（imageLongEdge）: 整数で入れる');
    expect(alert).toContain('（text.prompt）: 1 以上で入れる');
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
      '（imageLongEdge）: 128 以上で入れる',
    );
    expect(input('imageLongEdge').value).toBe('64');
  });

  it('names the field by its label too when the form refuses a value', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);

    await user.type(input('candidates.maxSize'), 'abc');
    await user.click(saveButton());

    expect((await screen.findByRole('alert')).textContent).toContain(
      '考える役に見せる候補の量（candidates.maxSize）: 整数で入れる',
    );
    expect(mocks.saveBudgetSettings).not.toHaveBeenCalled();
  });

  it('names the field by its label too when the API says the sum goes over a window', async () => {
    const user = userEvent.setup();
    const [overflow] = findInputOverflows(resolveBudgets({ candidates: { maxSize: 12000 } }), {
      think: { contextTokens: 100, maxOutputTokens: 0 },
    });
    expect(overflow?.largestField?.path).toBe('candidates.maxSize');
    mocks.saveBudgetSettings.mockRejectedValue(
      new ApiError('invalid_request', describeInputOverflow(overflow!), 400),
    );
    render(<BudgetSettings />);

    await user.click(saveButton());

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('考える役に見せる候補の量（candidates.maxSize）');
    expect(alert).not.toContain('）（');
  });

  // ほかの設定の欄（LLM・許可・候補の説明）と同じ形にする: 素のボタンと素の文では、押す先が小さく、断られても欄の説明と見分けにくい
  it('saves with the same primary button as the other settings', () => {
    render(<BudgetSettings />);
    const saveClass = saveButton().className;
    cleanup();
    render(
      <Button type="submit" variant="primary">
        保存
      </Button>,
    );

    expect(saveClass).toBe(screen.getByRole('button', { name: '保存' }).className);
  });

  // 押した保存は送っている間押せなくなるので、断られたらフォーカスは断りへ移る。2回続けて断られても移る
  it('moves the focus to the reason when the API refuses, also on a second refusal', async () => {
    const user = userEvent.setup();
    mocks.saveBudgetSettings.mockRejectedValue(
      new ApiError('invalid_request', 'imageLongEdge: 128 以上で入れる', 400),
    );
    render(<BudgetSettings />);

    saveButton().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));

    saveButton().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));
  });

  it('moves the focus to the reasons when the form refuses several values, also when pressed again', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);
    await user.type(input('imageLongEdge'), '2.5');
    await user.type(input('text.prompt'), '0');

    saveButton().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));

    saveButton().focus();
    await user.keyboard('{Enter}');
    await expectFocusMovesTo(await screen.findByRole('alert'));
    expect(mocks.saveBudgetSettings).not.toHaveBeenCalled();
  });

  it('leaves the focus in a field being corrected after a refusal', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);
    await user.type(input('imageLongEdge'), '2.5');
    await user.click(saveButton());
    await expectFocusMovesTo(await screen.findByRole('alert'));

    await user.clear(input('imageLongEdge'));
    await user.type(input('imageLongEdge'), '256');

    expect(document.activeElement).toBe(input('imageLongEdge'));
    expect(input('imageLongEdge').value).toBe('256');
  });

  it('says it could not save in the same note as the other settings', async () => {
    const user = userEvent.setup();
    mocks.saveBudgetSettings.mockRejectedValue(
      new ApiError('invalid_request', '考える役の考える段は、…を 90777 トークン超える', 400),
    );
    render(<BudgetSettings />);

    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^保存できない: 考える役の考える段は/);
    expect(alert.getAttribute('data-slot')).toBe('alert');
  });

  it('lists several reasons inside the same note', async () => {
    const user = userEvent.setup();
    render(<BudgetSettings />);

    await user.type(input('imageLongEdge'), '2.5');
    await user.type(input('text.prompt'), '0');
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^保存できない:/);
    expect(alert.getAttribute('data-slot')).toBe('alert');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);
  });

  // 断る文をボタンの前に置かない: 最後の欄の直下に出ると、その欄の説明のように読めるため
  it.each([
    ['the form', ['2.5'], undefined],
    ['the API', ['64'], new ApiError('invalid_request', 'imageLongEdge: 128 以上で入れる', 400)],
  ])(
    'says it could not save after the save button when %s refuses, still letting the person save again',
    async (_, [typed], refusal) => {
      const user = userEvent.setup();
      if (refusal !== undefined) mocks.saveBudgetSettings.mockRejectedValueOnce(refusal);
      render(<BudgetSettings />);

      await user.type(input('imageLongEdge'), typed!);
      await user.click(saveButton());

      const alert = await screen.findByRole('alert');
      expect(
        saveButton().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(saveButton().hasAttribute('disabled')).toBe(false);
    },
  );

  it('says the stored budgets cannot be read', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: undefined,
      error: new ApiError('invalid_config', 'config.json の budgets が不正', 500),
    });
    render(<BudgetSettings />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('config.json の budgets が不正');
    expect(alert.getAttribute('data-slot')).toBe('alert');
  });
});

// API が invalid[].reason に返す形（config.json の欄名と日本語の説明と原文までを含む1文）
const PROMPT_REASON =
  'config.json の budgets.text.prompt が読めない（1 以上）（原文: Too small: expected number to be >=1）';
const LONG_EDGE_REASON =
  'config.json の budgets.imageLongEdge が読めない（128 以上）（原文: Too small: expected number to be >=128）';

describe('BudgetInvalidNotice', () => {
  it('shows nothing when every field of budgets was read', () => {
    const { container } = render(<BudgetInvalidNotice />);

    expect(container.textContent).toBe('');
  });

  it('shows the sentence of the API as it is, without putting the field name in front', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: {
        ...stored,
        invalid: [
          {
            path: 'text.prompt',
            reason:
              'config.json の budgets.text.prompt が読めない（1 以上）（原文: Too small: expected number to be >=1）',
          },
          {
            path: 'text.unknownField',
            reason:
              'config.json の budgets.text.unknownField が読めない（知らない欄）（原文: nope）',
          },
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
      'config.json の budgets.text.prompt が読めない（1 以上）（原文: Too small: expected number to be >=1）',
      'config.json の budgets.text.unknownField が読めない（知らない欄）（原文: nope）',
    ]);
  });

  it('says the whole budgets could not be read', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: {
        ...stored,
        invalid: [{ path: '*', reason: 'config.json の budgets: 予算が読めない' }],
      },
      error: undefined,
    });
    render(<BudgetInvalidNotice />);

    expect(screen.getByRole('listitem').textContent).toBe('config.json の budgets: 予算が読めない');
  });

  it('marks the field in the form that went back to the default', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: { ...stored, invalid: [{ path: 'text.prompt', reason: PROMPT_REASON }] },
      error: undefined,
    });
    render(<BudgetSettings />);

    expect(
      screen.getByText(`config.json の値が読めず、既定の値に戻している: ${PROMPT_REASON}`),
    ).toBeTruthy();
    expect(screen.getAllByText(/既定の値に戻している/)).toHaveLength(1);
  });

  it('gives each marked field its own reason', () => {
    mocks.useBudgetSettings.mockReturnValue({
      data: {
        ...stored,
        invalid: [
          { path: 'text.prompt', reason: PROMPT_REASON },
          { path: 'imageLongEdge', reason: LONG_EDGE_REASON },
        ],
      },
      error: undefined,
    });
    render(<BudgetSettings />);

    // 欄の添え書きは、その欄の label のすぐ後ろにある
    const noteOf = (path: string) =>
      input(path).closest('label')?.nextElementSibling?.textContent ?? null;
    expect(noteOf('text.prompt')).toBe(
      `config.json の値が読めず、既定の値に戻している: ${PROMPT_REASON}`,
    );
    expect(noteOf('imageLongEdge')).toBe(
      `config.json の値が読めず、既定の値に戻している: ${LONG_EDGE_REASON}`,
    );
    expect(noteOf('text.intent')).toBeNull();
  });
});
