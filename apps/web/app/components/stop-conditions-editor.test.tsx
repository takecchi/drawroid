// @vitest-environment jsdom
import { parseStopConditionsText, type StopConditionsDraftResponse } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STOP_CONDITIONS_FORM,
  type StopConditionsFormValues,
} from '../lib/stop-conditions-form';
import { StopConditionsEditor } from './stop-conditions-editor';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  parseStopConditionsText: vi.fn(),
}));

const parse = vi.mocked(parseStopConditionsText);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

type Draft = StopConditionsDraftResponse['draft'];

async function apiError(kind: string, message: string, status: number) {
  const { ApiError } = await vi.importActual<typeof import('@drawroid/swr')>('@drawroid/swr');
  return new ApiError(kind, message, status);
}

function draftOf(draft: Partial<Draft>): StopConditionsDraftResponse {
  return {
    draft: { conditions: { aiJudgement: false }, unparsed: [], warnings: [], ...draft },
  } as StopConditionsDraftResponse;
}

function Harness({
  initial = DEFAULT_STOP_CONDITIONS_FORM,
  onConfirm = () => {},
}: {
  initial?: StopConditionsFormValues;
  onConfirm?: () => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <StopConditionsEditor
      values={values}
      onChange={setValues}
      confirm={{ label: '確定', pending: false, onConfirm }}
    />
  );
}

async function makeDraftFrom(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/文から案を作る/), text);
  await user.click(screen.getByRole('button', { name: '案を作る' }));
  return user;
}

describe('StopConditionsEditor', () => {
  it('fills the form with the draft returned for the typed sentence', async () => {
    parse.mockResolvedValue(
      draftOf({
        conditions: { aiJudgement: false, maxIterations: 5, maxImages: 12, maxDurationMs: 90_000 },
      }),
    );
    render(<Harness />);

    await makeDraftFrom('5 回まで');

    expect(parse).toHaveBeenCalledWith('5 回まで');
    expect(await screen.findByLabelText(/回数の上限/)).toHaveProperty('value', '5');
    expect(screen.getByLabelText(/枚数の上限/)).toHaveProperty('value', '12');
    expect(screen.getByLabelText(/時間の上限/)).toHaveProperty('value', '1.5');
    expect(screen.getByLabelText(/AI が意図どおり/)).toHaveProperty('checked', false);
  });

  it('says once that a draft never stops and shows the phrases it could not read', async () => {
    parse.mockResolvedValue(
      draftOf({
        conditions: { aiJudgement: false },
        unparsed: ['夕方になったら'],
        warnings: [{ kind: 'never-stops', message: '警告: この案は止まらない' }],
      }),
    );
    render(<Harness />);

    await makeDraftFrom('夕方になったら止める');

    expect(await screen.findByText('夕方になったら')).toBeTruthy();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('この条件では止まらない');
    expect(screen.queryByText('警告: この案は止まらない')).toBeNull();
  });

  it('keeps the confirm button disabled and explains why while nothing can stop the job', () => {
    const onConfirm = vi.fn();
    render(
      <Harness
        initial={{ ...DEFAULT_STOP_CONDITIONS_FORM, aiJudgement: false, maxIterations: '' }}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole('button', { name: '確定' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toContain('この条件では止まらない');
  });

  it('enables the confirm button once a limit is typed', async () => {
    const onConfirm = vi.fn();
    render(
      <Harness
        initial={{ ...DEFAULT_STOP_CONDITIONS_FORM, aiJudgement: false, maxIterations: '' }}
        onConfirm={onConfirm}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/回数の上限/), '3');
    await user.click(screen.getByRole('button', { name: '確定' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('explains that the LLM is not configured when the API answers 409', async () => {
    parse.mockRejectedValue(await apiError('llm_not_configured', 'LLM の設定が無い', 409));
    render(<Harness />);

    await makeDraftFrom('10 回まで');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('LLM が未設定');
    expect(alert.textContent).toContain('LLM の設定が無い');
  });

  it('explains that the sentence could not be read when the API answers 422', async () => {
    parse.mockRejectedValue(await apiError('unparsable', '条件が見つからない', 422));
    render(<Harness />);

    await makeDraftFrom('いい感じに');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('文を読み取れなかった');
    expect(alert.textContent).toContain('条件が見つからない');
  });
});
