// @vitest-environment jsdom
import { adoptImage } from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IterationList, type Iteration } from './iteration-view';

// 窓を開く試験と同じファイルに置かない: 閉じた窓が縮小版へフォーカスを戻す処理は片付けのあとに走り、次の試験の縮小版を拾うため
vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  adoptImage: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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

// 決めるとジョブは止まり、止まった知らせが決めた記録（adopted）より先に届くことがある。その間も、決めた画像は決めた印のまま、フォーカスも印に残る
describe('IterationList when deciding stops the job', () => {
  it('keeps the mark and the focus where the person decided, until the choice is recorded', async () => {
    vi.mocked(adoptImage).mockResolvedValue({ adopted: { iteration: 1, index: 0 } } as never);
    const user = userEvent.setup();
    const list = (stopped: boolean, shown: Iteration) => (
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[shown]}
        calls={[]}
        verdicts={new Map()}
        adopt={{ stopped }}
      />
    );
    const { rerender } = render(list(false, iteration));
    screen.getByRole('button', { name: 'この画像に決める: 1 回目の画像 1 番' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(await screen.findByText('この画像に決めた'));

    rerender(list(true, iteration));
    expect(document.activeElement).toBe(screen.getByText('この画像に決めた'));

    const recorded = {
      ...iteration,
      adopted: { image: { iteration: 1, index: 0 }, score: 1 },
    } as unknown as Iteration;
    rerender(list(true, recorded));
    expect(document.activeElement).toBe(screen.getByText('この画像に決めた'));
  });
});
