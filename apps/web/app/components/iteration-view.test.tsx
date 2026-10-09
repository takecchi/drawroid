// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adoptImage, recheckJobDistill, setSelection } from '@drawroid/swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IterationList, type Iteration } from './iteration-view';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  adoptImage: vi.fn(),
  recheckJobDistill: vi.fn(),
  setSelection: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const iteration = {
  iteration: 1,
  think: null,
  excluded: null,
  judge: null,
  adopted: null,
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
  it('says so when no image has been made yet', () => {
    render(
      <IterationList jobId="job-1" heading="回" iterations={[]} calls={[]} verdicts={new Map()} />,
    );

    expect(screen.getByText('まだ画像は無い。')).toBeTruthy();
  });

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

describe('IterationList and an iteration the human picked an image in', () => {
  const adoptedRecord = {
    by: 'human',
    image: { iteration: 1, index: 1 },
    score: 1,
    interventionId: 'iv-1',
    adoptedAt: '2026-10-09T00:30:00.000Z',
  };
  const twoImages = [
    { index: 0, seed: 7, url: '/a.png', previewUrl: '/a.webp' },
    { index: 1, seed: 8, url: '/b.png', previewUrl: '/b.webp' },
  ];

  it('shows that a human chose, which image, and score 1 instead of an empty evaluation', () => {
    renderList(false, { ...iteration, images: twoImages, adopted: adoptedRecord } as Iteration);

    const section = screen.getByRole('heading', { name: '評価' }).closest('section');
    expect(section?.textContent).toContain('人が選んだ');
    expect(section?.textContent).toContain('画像 2 番');
    expect(section?.textContent).toContain('score 1.00');
    expect(screen.getAllByText(/人が選んだ \/ score 1.00/)).toHaveLength(1);
  });

  it('keeps showing the judge evaluation as before for an iteration the judge evaluated', () => {
    renderList(false, {
      ...iteration,
      judge: { images: [{ score: 0.5, issues: [] }], nextChange: '次', canStop: false },
      adopted: null,
    } as unknown as Iteration);

    expect(screen.getByRole('heading', { name: '見る役の評価' })).toBeTruthy();
    expect(screen.queryByText(/人が選んだ/)).toBeNull();
  });
});

describe('IterationList and the large view of an image', () => {
  it('opens an image large with the judge score and words, the selection buttons and the adopt button', async () => {
    const user = userEvent.setup();
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[
          {
            ...iteration,
            judge: {
              images: [{ score: 0.5, issues: ['指が崩れている'] }],
              nextChange: '次',
              canStop: false,
            },
          } as unknown as Iteration,
        ]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped: false }}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番（seed 7）' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: /1 回目の画像 1 番/ }));

    expect(dialog.getByText('見る役の点 0.50')).toBeTruthy();
    expect(dialog.getByText('指が崩れている')).toBeTruthy();
    expect(dialog.getAllByRole('button', { name: /お気に入り/ }).length).toBeGreaterThan(0);
    expect(
      dialog.getByRole('button', { name: 'この画像で決める: 1 回目の画像 1 番' }),
    ).toBeTruthy();
  });

  it('in the large view, lets a stopped job be settled through the favorite only, without a reason it cannot', async () => {
    const user = userEvent.setup();
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[iteration]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped: true }}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番（seed 7）' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: /1 回目の画像 1 番/ }));

    // 止まったジョブは採る口を受けないので、「この画像に決める（お気に入りにする）」になる。押せない理由は出さない
    expect(
      dialog.queryByRole('button', { name: 'この画像で決める: 1 回目の画像 1 番' }),
    ).toBeNull();
    expect(dialog.queryByText(/決められない/)).toBeNull();
    await user.click(
      dialog.getByRole('button', {
        name: 'この画像に決める（お気に入りにする）: 1 回目の画像 1 番',
      }),
    );
    expect(setSelection).toHaveBeenCalledWith('job-1', '1-0', 'favorite');
    expect(adoptImage).not.toHaveBeenCalled();
    expect(recheckJobDistill).toHaveBeenCalledWith('job-1');
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
