// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { HydrateFallback } from './root';

afterEach(() => {
  cleanup();
});

describe('HydrateFallback', () => {
  it('says the page is loading, and keeps what to do next ready for when it takes long', () => {
    render(<HydrateFallback />);

    expect(screen.getByRole('status').textContent).toContain('読み込んでいます…');
    // 時間が経ってから CSS で見せる案内。最初から置いておく（JS が動かなくても出るように）
    const hint = screen.getByText(/読み込みに時間がかかっている/);
    expect(hint.className).toContain('hydrate-slow-hint');
    expect(hint.textContent).toContain('ターミナル');
  });
});
