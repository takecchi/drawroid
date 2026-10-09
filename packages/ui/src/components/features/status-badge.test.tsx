// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatusBadge, type StatusMap } from './status-badge';

afterEach(cleanup);

const MAP: StatusMap<'running' | 'stopped'> = {
  running: { tone: 'ok', label: '走行中' },
  stopped: { tone: 'muted', label: '止まった' },
};

describe('StatusBadge', () => {
  it('shows the label of a known status', () => {
    render(<StatusBadge status="running" map={MAP} />);

    expect(screen.getByText('走行中')).toBeTruthy();
  });

  it('shows the raw value of a status it does not know, instead of breaking', () => {
    render(
      <>
        <StatusBadge status="paused" map={MAP} />
        <StatusBadge status="constructor" map={MAP} />
      </>,
    );

    expect(screen.getByText('知らない状態（paused）')).toBeTruthy();
    expect(screen.getByText('知らない状態（constructor）')).toBeTruthy();
  });
});
