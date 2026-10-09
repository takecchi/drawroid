// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { IterationList, type Iteration } from './iteration-view';

afterEach(cleanup);

const iteration = {
  iteration: 1,
  think: null,
  judge: null,
  images: [{ index: 0, seed: 7, url: '/api/jobs/job-1/images/1-0.png', previewUrl: '/p.webp' }],
  request: {},
} as unknown as Iteration;

function renderList(canPaintMask?: boolean) {
  render(
    <IterationList
      jobId="job-1"
      heading="回"
      iterations={[iteration]}
      calls={[]}
      verdicts={new Map()}
      {...(canPaintMask !== undefined && { canPaintMask })}
    />,
  );
}

describe('IterationList and masks', () => {
  it('offers to paint a mask on each image while an automatic job can still take one', () => {
    renderList(true);

    expect(screen.getAllByRole('button', { name: 'マスクを塗る' })).toHaveLength(1);
  });

  it('does not offer it for a manual job or a job that has stopped', () => {
    renderList(false);
    expect(screen.queryByRole('button', { name: 'マスクを塗る' })).toBeNull();
    cleanup();

    renderList();
    expect(screen.queryByRole('button', { name: 'マスクを塗る' })).toBeNull();
  });
});
