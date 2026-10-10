// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Badge,
  Button,
  CheckboxField,
  ErrorNote,
  Field,
  FilePicker,
  Input,
  OkNote,
  Spinner,
  Textarea,
  WarnNote,
} from './common';

afterEach(cleanup);

describe('Button', () => {
  it('does not submit the surrounding form unless asked to', () => {
    render(
      <form>
        <Button>送る</Button>
        <Button type="submit">投入する</Button>
      </form>,
    );

    expect(screen.getByRole('button', { name: '送る' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: '投入する' }).getAttribute('type')).toBe('submit');
  });

  // 呼び手がフォーカスを移す先として掴めるように、ref は DOM の button に届ける
  it('hands its ref to the button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>送る</Button>);

    expect(ref.current).toBe(screen.getByRole('button', { name: '送る' }));
  });

  it('cannot be pressed while loading, and keeps its label as its name', async () => {
    let pressed = 0;
    render(
      <Button loading onClick={() => (pressed += 1)}>
        送る
      </Button>,
    );

    const button = screen.getByRole('button', { name: '送る' });
    expect(button).toHaveProperty('disabled', true);
    await userEvent.click(button);
    expect(pressed).toBe(0);
  });

  // jsdom は CSS を評価しないので、高さの段は class で見る
  it('is tall enough to press with a finger, and shrinks only on a wide screen with a fine pointer, in both sizes', () => {
    render(
      <>
        <Button>送る</Button>
        <Button size="sm">消す</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: '送る' }).className.split(' ')).toEqual(
      expect.arrayContaining(['h-11', 'md:pointer-fine:h-9']),
    );
    expect(screen.getByRole('button', { name: '消す' }).className.split(' ')).toEqual(
      expect.arrayContaining(['h-11', 'md:pointer-fine:h-7']),
    );
  });
});

describe('Badge', () => {
  it('wraps a long name instead of running out of its place', () => {
    render(<Badge>stable-diffusion-xl-base-1.0-very-long-model-name</Badge>);

    const badge = screen.getByText('stable-diffusion-xl-base-1.0-very-long-model-name');
    expect(badge.className.split(' ')).toEqual(
      expect.arrayContaining(['whitespace-normal', 'break-words']),
    );
    expect(badge.className.split(' ')).not.toContain('whitespace-nowrap');
  });
});

describe('WarnNote', () => {
  it('holds paragraphs and lists without breaking the nesting of the page', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <WarnNote>
        <p>長い依頼は切られる。</p>
        <ul>
          <li>短くする</li>
        </ul>
      </WarnNote>,
    );

    expect(screen.getByRole('status').textContent).toContain('長い依頼は切られる。');
    expect(screen.getByText('長い依頼は切られる。').parentElement?.tagName).toBe('DIV');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('Spinner', () => {
  it('is announced by its Japanese label alone', () => {
    render(<Spinner label="ジョブを読み込み中" />);

    expect(screen.getByRole('status').textContent).toBe('ジョブを読み込み中');
    expect(screen.queryByLabelText('Loading')).toBeNull();
  });
});

describe('ErrorNote', () => {
  it('is announced as an alert with its message', () => {
    render(<ErrorNote>送れない: 依頼が長すぎる</ErrorNote>);

    expect(screen.getByRole('alert').textContent).toContain('依頼が長すぎる');
  });
});

describe('OkNote', () => {
  // 押したボタンが消えてフォーカスが外れても、通ったことが読み上げに届くように
  it('is announced as a status with its message', () => {
    render(<OkNote>保存した。</OkNote>);

    expect(screen.getByRole('status').textContent).toBe('保存した。');
  });

  // 押して保存したときは、知らせへフォーカスを移す（出たときの一度だけ）。渡さなければ移さない
  it('takes the focus when it appears, only when asked and only once', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    const { unmount } = render(<OkNote>送った。</OkNote>);
    expect(document.activeElement).toBe(elsewhere);
    unmount();

    const { rerender } = render(<OkNote focus>保存した。</OkNote>);
    expect(document.activeElement).toBe(screen.getByRole('status'));

    elsewhere.focus();
    rerender(<OkNote focus>保存した。次から効く。</OkNote>);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe('Field', () => {
  it('lets the control be found by its label', () => {
    render(
      <Field label="回数の上限">
        <Input defaultValue="10" />
      </Field>,
    );

    expect(screen.getByLabelText('回数の上限')).toHaveProperty('value', '10');
  });

  it('keeps the checkbox a native checkbox found by its label', () => {
    render(<CheckboxField label="AI が意図どおりと判断したら止める" defaultChecked />);

    expect(screen.getByLabelText('AI が意図どおりと判断したら止める')).toHaveProperty(
      'checked',
      true,
    );
  });
});

describe('FilePicker', () => {
  const file = (name: string) => new File(['x'], name, { type: 'image/png' });

  it('stays a file input found by the surrounding label and shows the picked names', async () => {
    const user = userEvent.setup();
    render(
      <Field label="参照画像を選ぶ">
        <FilePicker multiple />
      </Field>,
    );

    expect(screen.getByText('選んでいない')).toBeTruthy();
    await user.upload(screen.getByLabelText(/参照画像を選ぶ/), [file('a.png'), file('b.png')]);

    expect(screen.getByText('a.png、b.png')).toBeTruthy();
  });

  it('shows the names it is given instead of the last pick', () => {
    render(
      <Field label="参照画像を選ぶ">
        <FilePicker selected={['kept.png']} />
      </Field>,
    );

    expect(screen.getByText('kept.png')).toBeTruthy();
  });
});

describe('Textarea', () => {
  it('grows to its content up to the given height when asked to', () => {
    // jsdom は配置をしないので、中身の高さを決めて渡す
    const height = vi
      .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(120);
    render(
      <>
        <Textarea aria-label="伸びる" maxHeight="15rem" defaultValue="一行目" />
        <Textarea aria-label="伸びない" defaultValue="一行目" />
      </>,
    );

    const grows = screen.getByLabelText('伸びる') as HTMLTextAreaElement;
    expect(grows.style.height).toBe('120px');
    expect(grows.style.maxHeight).toBe('15rem');
    expect((screen.getByLabelText('伸びない') as HTMLTextAreaElement).style.height).toBe('');
    height.mockRestore();
  });
});
