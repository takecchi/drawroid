// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { IterationList, type Iteration } from './iteration-view';

afterEach(cleanup);

const iteration = {
  iteration: 1,
  think: null,
  excluded: null,
  judge: null,
  images: [{ index: 0, seed: 7, url: '/api/jobs/job-1/images/1-0.png', previewUrl: '/p.webp' }],
  request: {},
} as unknown as Iteration;

function renderList(canPaintMask?: boolean, shown: Iteration = iteration) {
  render(
    <IterationList
      jobId="job-1"
      heading="回"
      iterations={[shown]}
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

describe('IterationList and what was left out of the AI choices', () => {
  const withExcluded = (excluded: Iteration['excluded']): Iteration => ({ ...iteration, excluded });

  it('shows each excluded param with what the human wanted and why it was left out', () => {
    renderList(
      false,
      withExcluded([
        { param: 'loras', wanted: 'auto', reason: { kind: 'no-candidates-shown' } },
        { param: 'controlnet', wanted: 'fixed', reason: { kind: 'backend', detail: '拡張が無い' } },
      ]),
    );

    expect(
      screen.getByRole('heading', { name: 'この回に AI の選択肢から外したもの' }),
    ).toBeTruthy();
    expect(
      screen.getByText('loras（AI に任せる）: 候補を予算の内で1つも見せられなかった'),
    ).toBeTruthy();
    expect(screen.getByText('controlnet（固定）: バックエンドで使えない: 拡張が無い')).toBeTruthy();
  });

  it.each<Iteration['excluded']>([null, []])(
    'shows no such section when excluded is %j',
    (excluded) => {
      renderList(false, withExcluded(excluded));

      expect(screen.queryByText('この回に AI の選択肢から外したもの')).toBeNull();
    },
  );
});
