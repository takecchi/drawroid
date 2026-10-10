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

describe('IterationList and what was sent to the backend', () => {
  it('calls the parameters sent for the iteration the generation request, in Japanese', () => {
    renderList(false, { ...iteration, request: { steps: 28 } } as unknown as Iteration);

    expect(screen.getByText('生成の要求')).toBeTruthy();
    expect(screen.queryByText('request')).toBeNull();
    expect(screen.getByText(/"steps": 28/)).toBeTruthy();
  });
});

describe('IterationList and an iteration that made no image', () => {
  const imageless = (think: unknown): Iteration =>
    ({ ...iteration, think, images: [], request: null }) as unknown as Iteration;
  const renderStopped = (stopped: boolean, shown: Iteration) =>
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[iteration, shown]}
        calls={[]}
        verdicts={new Map()}
        stopped={stopped}
      />,
    );

  it('says the job stopped after thinking, without making an image, so the count of iterations and images can differ', () => {
    renderStopped(true, { ...imageless({}), iteration: 2 });

    expect(
      screen.getByText('考える段まで進んだところでジョブが止まり、この回は画像を作っていない。'),
    ).toBeTruthy();
    // 画像を作った回には書かない
    expect(screen.getAllByText(/この回は画像を作っていない/)).toHaveLength(1);
    // 送っていない生成の要求は出さない
    expect(screen.getAllByText('生成の要求')).toHaveLength(1);
  });

  it('says the job stopped before thinking when the iteration has not even thought', () => {
    renderStopped(true, { ...imageless(null), iteration: 2 });

    expect(screen.getByText('考える前にジョブが止まり、この回は画像を作っていない。')).toBeTruthy();
  });

  it('says the iteration is still going while the job runs', () => {
    renderStopped(false, { ...imageless({}), iteration: 2 });

    expect(screen.getByText('この回の画像はまだ無い（進めている途中）。')).toBeTruthy();
    expect(screen.queryByText(/ジョブが止まり/)).toBeNull();
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

  it('shows that a human chose, which image, and the point 1 instead of an empty evaluation', () => {
    renderList(false, { ...iteration, images: twoImages, adopted: adoptedRecord } as Iteration);

    const section = screen.getByRole('heading', { name: '評価' }).closest('section');
    expect(section?.textContent).toContain('人が選んだ');
    expect(section?.textContent).toContain('画像 2 番');
    // 選んだ印の点は、見る役の点とは書かない
    expect(section?.textContent).toContain('点 1.00');
    expect(section?.textContent).not.toContain('見る役の点');
    expect(screen.getAllByText(/人が選んだ \/ 点 1.00/)).toHaveLength(1);
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
      dialog.getByRole('button', { name: 'この画像に決める: 1 回目の画像 1 番' }),
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
      dialog.queryByRole('button', { name: 'この画像に決める: 1 回目の画像 1 番' }),
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

// 止まったジョブの画像の枡（窓の外）も、窓と同じく「この画像に決める（お気に入りにする）」にする。人が選んだ画像は、枡でも窓でも「選んだ」のまま
describe('IterationList and the image cells of a stopped job', () => {
  const twoImages = [
    { index: 0, seed: 7, url: '/a.png', previewUrl: '/a.webp' },
    { index: 1, seed: 8, url: '/b.png', previewUrl: '/b.webp' },
  ];
  const chose = (index: number) => ({
    by: 'human',
    image: { iteration: 1, index },
    score: 1,
    interventionId: 'iv-1',
    adoptedAt: '2026-10-09T00:30:00.000Z',
  });

  it('offers to settle through the favorite in each cell, not the adopt button', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[{ ...iteration, images: twoImages } as Iteration]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped: true }}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: 'この画像に決める（お気に入りにする）: 1 回目の画像 2 番',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^この画像に決める:/ })).toBeNull();
  });

  it('keeps saying a human chose the image they chose, and offers the favorite for the others', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[
          { ...iteration, images: twoImages, adopted: chose(1) } as unknown as Iteration,
        ]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped: true }}
      />,
    );

    expect(screen.getByText('この画像に決めた')).toBeTruthy();
    expect(
      screen.queryByRole('button', {
        name: 'この画像に決める（お気に入りにする）: 1 回目の画像 2 番',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'この画像に決める（お気に入りにする）: 1 回目の画像 1 番',
      }),
    ).toBeTruthy();
  });

  it('keeps saying a human chose the image they chose in the large view too', async () => {
    const user = userEvent.setup();
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[
          { ...iteration, images: twoImages, adopted: chose(1) } as unknown as Iteration,
        ]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped: true }}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: '大きく見る: 1 回目の画像 2 番（seed 8）' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: /1 回目の画像 2 番/ }));

    expect(dialog.getByText('この画像に決めた')).toBeTruthy();
    expect(
      dialog.queryByRole('button', { name: /^この画像に決める（お気に入りにする）:/ }),
    ).toBeNull();
  });
});

// 走っている自動ジョブの画像の枡は、止まったジョブと取り違えず、採る口（この画像に決める）を出す
describe('IterationList and the image cells of a running job', () => {
  it('offers the adopt button, not the favorite, in each cell', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[
          {
            ...iteration,
            images: [
              { index: 0, seed: 7, url: '/a.png', previewUrl: '/a.webp' },
              { index: 1, seed: 8, url: '/b.png', previewUrl: '/b.webp' },
            ],
          } as Iteration,
        ]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped: false }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'この画像に決める: 1 回目の画像 1 番' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'この画像に決める: 1 回目の画像 2 番' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^この画像に決める（お気に入りにする）:/ }),
    ).toBeNull();
  });
});

// 止まったジョブでは、お気に入りにした画像が決めた画像。保存された選び方から出すので、開き直しても同じに出る
describe('IterationList for a stopped job whose image is already a favorite', () => {
  const twoImages = [
    { index: 0, seed: 7, url: '/a.png', previewUrl: '/a.webp' },
    { index: 1, seed: 8, url: '/b.png', previewUrl: '/b.webp' },
  ];
  const cellOf = (index: number) =>
    within(
      screen
        .getByRole('button', { name: `大きく見る: 1 回目の画像 ${index} 番（seed ${index + 6}）` })
        .closest('figure')!,
    );

  it('marks the favorite as the image the person decided on, in its cell and in the large view', async () => {
    const user = userEvent.setup();
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[{ ...iteration, images: twoImages } as Iteration]}
        calls={[]}
        verdicts={new Map([['1-0', 'favorite']])}
        adopt={{ stopped: true }}
      />,
    );

    expect(cellOf(1).getByText('この画像に決めた（お気に入り）')).toBeTruthy();
    expect(
      cellOf(1).queryByRole('button', { name: /^この画像に決める（お気に入りにする）:/ }),
    ).toBeNull();
    // まだ何も選んでいない画像には出さない
    expect(cellOf(2).queryByText(/^この画像に決めた/)).toBeNull();
    await user.click(
      screen.getByRole('button', { name: '大きく見る: 1 回目の画像 1 番（seed 7）' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: /1 回目の画像 1 番/ }));
    expect(dialog.getByText('この画像に決めた（お気に入り）')).toBeTruthy();
  });

  it('does not mark an image that is not a favorite, and still offers to decide on it', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[{ ...iteration, images: twoImages } as Iteration]}
        calls={[]}
        verdicts={
          new Map([
            ['1-0', 'favorite'],
            ['1-1', 'rejected'],
          ])
        }
        adopt={{ stopped: true }}
      />,
    );

    expect(screen.getAllByText(/^この画像に決めた/)).toHaveLength(1);
    expect(cellOf(2).queryByText(/^この画像に決めた/)).toBeNull();
    expect(
      cellOf(2).getByRole('button', {
        name: 'この画像に決める（お気に入りにする）: 1 回目の画像 2 番',
      }),
    ).toBeTruthy();
  });

  it('does not take a favorite of a running job as decided, since that job takes the image through adopting', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[{ ...iteration, images: twoImages } as Iteration]}
        calls={[]}
        verdicts={new Map([['1-0', 'favorite']])}
        adopt={{ stopped: false }}
      />,
    );

    expect(screen.queryByText(/^この画像に決めた/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'この画像に決める: 1 回目の画像 1 番' }),
    ).toBeTruthy();
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

// ジョブの詳細の画像の枡も、点数は「見る役の点」と書く（#281: 会話の行・窓・止まりのカードとそろえる）
describe('IterationList and the judge score in each image cell', () => {
  it('names the score as the judge score', () => {
    renderList(false, {
      ...iteration,
      judge: { images: [{ score: 0.5, issues: [] }], nextChange: '次', canStop: false },
    } as unknown as Iteration);

    expect(screen.getByText('見る役の点 0.50')).toBeTruthy();
    expect(screen.queryByText(/score 0\.50/)).toBeNull();
  });
});
