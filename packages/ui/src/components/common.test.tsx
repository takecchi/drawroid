// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button, CheckboxField, ErrorNote, Field, Input } from './common';

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
