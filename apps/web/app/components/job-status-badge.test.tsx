// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { STATUS_LABELS } from '../lib/job-labels';
import { JobStatusBadge } from './job-status-badge';

afterEach(cleanup);

describe('JobStatusBadge', () => {
  // jsdom は CSS を評価しないので、色の段は class で見る
  it.each([
    ['running', 'text-ok'],
    ['queued', 'text-warn'],
    ['stopped', 'text-muted-foreground'],
  ] as const)('shows %s by its label in the tone it has always had', (status, toneClass) => {
    render(<JobStatusBadge status={status} />);

    const badge = screen.getByText(STATUS_LABELS[status]);
    expect(badge.className.split(' ')).toContain(toneClass);
  });
});
