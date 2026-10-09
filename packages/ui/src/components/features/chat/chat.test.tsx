// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChatComposer,
  ChatLayout,
  GenerationProgress,
  JudgeNote,
  MessageRow,
  ReasoningBlock,
  StatusLine,
  StopNotice,
  ToolCallCard,
} from './index';

afterEach(cleanup);

const detailsOf = (text: string) => screen.getByText(text).closest('details') as HTMLDetailsElement;

describe('ReasoningBlock', () => {
  it('stays open while streaming and folds once the reasoning is final', () => {
    const { rerender } = render(<ReasoningBlock streaming>考えている途中</ReasoningBlock>);
    expect(detailsOf('考えている途中').open).toBe(true);

    rerender(<ReasoningBlock>考え終わった</ReasoningBlock>);

    expect(detailsOf('考え終わった').open).toBe(false);
  });

  it('can be opened again after it folds, and stays open on later renders', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ReasoningBlock>確定した思考</ReasoningBlock>);

    await user.click(screen.getByText('思考'));
    rerender(<ReasoningBlock>確定した思考</ReasoningBlock>);

    expect(detailsOf('確定した思考').open).toBe(true);
  });
});

describe('MessageRow', () => {
  it('marks who spoke and whether the message was cut short', () => {
    render(
      <>
        <MessageRow author="human">描いて</MessageRow>
        <MessageRow author="ai" truncated>
          途中まで
        </MessageRow>
      </>,
    );

    expect(screen.getByText('描いて').closest('[data-author]')?.getAttribute('data-author')).toBe(
      'human',
    );
    expect(screen.getByText('途中まで').closest('[data-author]')?.textContent).toContain(
      '打ち切り',
    );
  });
});

describe('ToolCallCard', () => {
  it('shows the tool as running until its result arrives', () => {
    const { rerender } = render(<ToolCallCard name="start_drawing" state="running" />);
    expect(screen.getByText('実行中')).toBeTruthy();

    rerender(<ToolCallCard name="start_drawing" state="ok" result="ジョブを作った" />);

    expect(screen.getByText('済み')).toBeTruthy();
    expect(screen.getByText('ジョブを作った')).toBeTruthy();
  });
});

describe('GenerationProgress', () => {
  it('shows the percentage, steps and remaining time when the backend reports them', () => {
    render(<GenerationProgress iteration={2} progress={0.35} step={7} steps={20} etaMs={5200} />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35');
    expect(screen.getByText(/7 \/ 20 ステップ/).textContent).toContain('残り約 5 秒');
  });

  it('shows the image in progress only when one is given', () => {
    const { rerender } = render(<GenerationProgress iteration={2} progress={0.35} />);
    expect(screen.queryByRole('img')).toBeNull();

    rerender(<GenerationProgress iteration={2} progress={0.35} previewSrc="/preview?step=7" />);

    expect(screen.getByRole('img', { name: '2 回目の途中の画像' }).getAttribute('src')).toBe(
      '/preview?step=7',
    );
  });

  it('says only that it is generating when the backend reports no progress', () => {
    render(<GenerationProgress />);

    expect(screen.getByText('生成中')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });
});

describe('JudgeNote', () => {
  it('turns the judge fields into a fixed sentence', () => {
    render(
      <>
        <JudgeNote iteration={1} canStop={false} nextChange="手を隠す" />
        <JudgeNote iteration={2} canStop />
      </>,
    );

    expect(screen.getByText('ちょっと違う。次は「手を隠す」。')).toBeTruthy();
    expect(screen.getByText('これで意図どおりと見ている。')).toBeTruthy();
  });

  it('says which image a human chose when the choice settled the iteration', () => {
    render(<JudgeNote iteration={3} canStop={false} adopted={{ iteration: 2, number: 4 }} />);

    expect(
      screen.getByText('この回は、人間が選んだ画像（2 回目の画像 4 番）で決まり。'),
    ).toBeTruthy();
  });
});

describe('StopNotice', () => {
  it('announces only failures as alerts', () => {
    render(
      <>
        <StopNotice tone="done">止まった</StopNotice>
        <StopNotice tone="error">失敗した</StopNotice>
      </>,
    );

    expect(screen.getByRole('alert').textContent).toBe('失敗した');
  });
});

function Composer({
  onSend,
  running = false,
}: {
  onSend: (text: string) => void;
  running?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      onSend={() => {
        onSend(value);
        setValue('');
      }}
      onStop={() => undefined}
      running={running}
    />
  );
}

describe('ChatComposer', () => {
  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    await user.type(screen.getByLabelText('発言'), '一行目{Shift>}{Enter}{/Shift}二行目{Enter}');

    expect(onSend).toHaveBeenCalledWith('一行目\n二行目');
  });

  it('does not send on the Enter that confirms a kana-kanji conversion', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = screen.getByLabelText('発言');
    fireEvent.change(box, { target: { value: 'ゆうぐれ' } });

    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send an empty message', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    await user.type(screen.getByLabelText('発言'), '   {Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /送る/ })).toHaveProperty('disabled', true);
  });

  it('still sends while the assistant is replying, and offers to stop', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} running />);

    await user.type(screen.getByLabelText('発言'), 'これでいい{Enter}');

    expect(onSend).toHaveBeenCalledWith('これでいい');
    expect(screen.getByRole('button', { name: '止める' })).toBeTruthy();
  });

  it('hides the stop button when nothing is running', () => {
    render(<Composer onSend={() => undefined} />);

    expect(screen.queryByRole('button', { name: '止める' })).toBeNull();
  });
});

describe('ChatLayout status', () => {
  const layout = (status?: 'waiting-llm' | 'job.held') => (
    <ChatLayout
      log={<div>{status !== undefined && <StatusLine status={status} />}</div>}
      composer={<div />}
      status={status}
    />
  );

  it('tells a screen reader of each change of state in one place that is always there', () => {
    const { rerender } = render(layout());
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    rerender(layout('waiting-llm'));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('考えています');

    rerender(layout('job.held'));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('話を聞いています（描くのは待たせています）');
  });

  it('keeps the visible status line out of what is read aloud, so it is not read twice', () => {
    render(layout('waiting-llm'));

    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
