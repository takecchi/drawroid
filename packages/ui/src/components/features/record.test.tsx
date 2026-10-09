// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthorMark, ImageCard } from './record';

afterEach(cleanup);

describe('AuthorMark', () => {
  it('tells the human and the AI apart by the record that holds the label', () => {
    render(
      <>
        <AuthorMark author="human" label="人間の指示" />
        <AuthorMark author="ai" label="AI（考える役）" />
      </>,
    );

    const authorOf = (label: string) =>
      screen.getByText(label).closest('[data-author]')?.getAttribute('data-author');
    expect(authorOf('人間の指示')).toBe('human');
    expect(authorOf('AI（考える役）')).toBe('ai');
  });

  it('keeps the label inside the record it names', () => {
    render(
      <AuthorMark author="human" label="人間の指示" meta="9:03">
        <p>もっと青く</p>
      </AuthorMark>,
    );

    expect(screen.getByText('人間の指示').parentElement?.textContent).toContain('もっと青く');
  });
});

describe('ImageCard', () => {
  it('links the preview to the full image and exposes the verdict', () => {
    const { container } = render(
      <ImageCard href="/full.png" src="/preview.webp" alt="seed 1" verdict="favorite" />,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe('/full.png');
    expect(screen.getByAltText('seed 1').getAttribute('src')).toBe('/preview.webp');
    expect(container.querySelector('figure')?.getAttribute('data-verdict')).toBe('favorite');
  });
});
