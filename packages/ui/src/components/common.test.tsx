// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { Button, CheckboxField, ErrorNote, Field, FilePicker, Input } from './common';

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
});

describe('ErrorNote', () => {
  it('is announced as an alert with its message', () => {
    render(<ErrorNote>送れない: 依頼が長すぎる</ErrorNote>);

    expect(screen.getByRole('alert').textContent).toContain('依頼が長すぎる');
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
