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

  it('is named after the tool and its state, so that it reads as one card', () => {
    render(<ToolCallCard name="describe_backend" state="error" result="繋がらない" />);

    const card = screen.getByRole('group', { name: 'ツール describe_backend: 失敗' });
    expect(card.textContent).toContain('繋がらない');
  });

  it('uses the human title for its heading and name, and folds the details', () => {
    render(
      <ToolCallCard
        name="start_drawing"
        title="描き始める"
        state="ok"
        result="ジョブで描き始めた。"
        details={<code>{'{"request":"猫"}'}</code>}
      />,
    );

    const card = screen.getByRole('group', { name: 'ツール 描き始める: 済み' });
    expect(card.textContent).toContain('ジョブで描き始めた。');
    const folded = screen.getByText('{"request":"猫"}').closest('details');
    expect(folded?.open).toBe(false);
    expect(folded?.querySelector('summary')?.textContent).toBe('詳しく');
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

  it('stops the spinning mark while stalled, and spins it otherwise', () => {
    const { container, rerender } = render(<GenerationProgress iteration={2} progress={0.35} />);
    expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);

    rerender(<GenerationProgress iteration={2} progress={0.35} stalled />);

    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(false);
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

  it('cannot be sent twice while the message is still being sent', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatComposer value="海の絵" onChange={() => undefined} onSend={onSend} sending />);

    await user.type(screen.getByLabelText('発言'), '{Enter}');
    await user.click(screen.getByRole('button', { name: /送る/ }));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /送る/ })).toHaveProperty('disabled', true);
  });

  it('shows a ring on the send button only while the message is being sent', () => {
    const ring = () =>
      screen.getByRole('button', { name: /送る/ }).querySelector('[data-slot="spinner"]');
    const { rerender } = render(
      <ChatComposer value="海の絵" onChange={() => undefined} onSend={() => undefined} />,
    );
    expect(ring()).toBeNull();

    rerender(
      <ChatComposer value="海の絵" onChange={() => undefined} onSend={() => undefined} sending />,
    );
    expect(ring()).not.toBeNull();
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

/** 添えた画像を持ち、外せる入力欄（呼び手と同じく、外したら並びから除く） */
function ComposerWithAttachments({ names }: { names: string[] }) {
  const [attachments, setAttachments] = useState(
    names.map((name) => ({ id: name, name, url: `blob:${name}` })),
  );
  return (
    <ChatComposer
      value=""
      onChange={() => undefined}
      onSend={() => undefined}
      attachments={attachments}
      onAttach={() => undefined}
      onRemoveAttachment={(id) => setAttachments((current) => current.filter((a) => a.id !== id))}
    />
  );
}

// 押したボタンは消えるか押せなくなる。フォーカスをページの外（body）に落とさず、次に使う所へ移す。押していないときは移さない
describe('ChatComposer focus', () => {
  const field = () => screen.getByLabelText('発言');

  it('moves the focus to the message field after sending with the send button', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={() => undefined} />);
    await user.type(field(), '海の絵');

    screen.getByRole('button', { name: /送る/ }).focus();
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(field());
  });

  it('moves the focus to the message field after stopping', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={() => undefined} running />);

    screen.getByRole('button', { name: '止める' }).focus();
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(field());
  });

  it.each([
    ['the one in the middle', 'b.png を外す', 'c.png を外す'],
    ['the last one', 'c.png を外す', 'b.png を外す'],
  ])(
    'moves the focus to the attachment left in its place after removing %s',
    async (_, removed, next) => {
      const user = userEvent.setup();
      render(<ComposerWithAttachments names={['a.png', 'b.png', 'c.png']} />);

      screen.getByRole('button', { name: removed }).focus();
      await user.keyboard('{Enter}');

      expect(screen.queryByRole('button', { name: removed })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: next }));
    },
  );

  it('moves the focus to adding an image after removing the only attachment', async () => {
    const user = userEvent.setup();
    render(<ComposerWithAttachments names={['a.png']} />);

    screen.getByRole('button', { name: 'a.png を外す' }).focus();
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '画像を添える' }));
  });

  // 送ったあとに呼び手が添付を空にしても、外したことにはしない（フォーカスは発言欄のまま）
  it('does not move the focus when the attachments change without a removal', () => {
    const props = { value: '', onChange: () => undefined, onSend: () => undefined };
    const { rerender } = render(
      <ChatComposer {...props} attachments={[{ id: 'a', name: 'a.png', url: 'blob:a' }]} />,
    );
    field().focus();

    rerender(<ChatComposer {...props} attachments={[]} onAttach={() => undefined} />);

    expect(document.activeElement).toBe(field());
  });

  // 外したことは1度だけ使う: 覚えたままだと、あとで送ったあとに呼び手が添付を空にしたとき、外したことにして奪うため
  it('does not move the focus again on a later change of the attachments, once a removal has been followed', () => {
    const props = {
      value: '',
      onChange: () => undefined,
      onSend: () => undefined,
      onAttach: () => undefined,
      onRemoveAttachment: () => undefined,
    };
    const a = { id: 'a', name: 'a.png', url: 'blob:a' };
    const b = { id: 'b', name: 'b.png', url: 'blob:b' };
    const { rerender } = render(<ChatComposer {...props} attachments={[a, b]} />);
    screen.getByRole('button', { name: 'a.png を外す' }).click();
    rerender(<ChatComposer {...props} attachments={[b]} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'b.png を外す' }));
    field().focus();

    rerender(<ChatComposer {...props} attachments={[]} />);

    expect(document.activeElement).toBe(field());
  });

  it('moves the focus to the message field when it starts with the focus, and only then', () => {
    const props = { value: '', onChange: () => undefined, onSend: () => undefined };
    const { unmount } = render(<ChatComposer {...props} focusOnMount />);
    expect(document.activeElement).toBe(field());
    unmount();

    render(<ChatComposer {...props} />);
    expect(document.activeElement).not.toBe(field());
  });

  // 出たときの一度だけ: 描き直しても、ほかの所へ移したフォーカスを取り戻さない
  it('does not take the focus back when it is drawn again', () => {
    const props = { value: '', onChange: () => undefined, onSend: () => undefined };
    const { rerender } = render(<ChatComposer {...props} focusOnMount />);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    rerender(<ChatComposer {...props} value="海" focusOnMount />);

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
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
