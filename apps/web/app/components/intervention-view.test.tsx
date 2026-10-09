// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { InterventionList, type Intervention } from './intervention-view';
import { IterationList, type Iteration } from './iteration-view';

afterEach(cleanup);

function instruction(id: string, text: string, appliedInIteration?: number): Intervention {
  return {
    kind: 'instruction',
    interventionId: id,
    receivedAt: '2026-01-01T00:00:00.000Z',
    text,
    ...(appliedInIteration === undefined ? {} : { appliedInIteration }),
  };
}

const stopChange: Intervention = {
  kind: 'stopConditions',
  interventionId: 'i-3',
  receivedAt: '2026-01-01T00:02:00.000Z',
  stopConditions: { aiJudgement: false, maxIterations: null, maxImages: 12 },
};

function iterationOf(n: number): Iteration {
  return {
    iteration: n,
    think: { params: { prompt: 'sunset' }, rationale: '光を足す' },
    excluded: null,
    judge: { images: [], nextChange: '影を濃く', canStop: false },
    images: [],
    request: {},
  } as unknown as Iteration;
}

describe('InterventionList', () => {
  it('says so when no human has given an instruction yet', () => {
    render(<InterventionList interventions={[]} />);

    expect(screen.getByText('まだ人間の指示は無い。')).toBeTruthy();
  });

  it('shows which image a mask was painted on and whether a redraw has used it', () => {
    const mask = (id: string, usedInIteration?: number): Intervention => ({
      kind: 'mask',
      interventionId: id,
      receivedAt: '2026-01-01T00:03:00.000Z',
      image: { iteration: 2, index: 1 },
      ...(usedInIteration === undefined ? {} : { usedInIteration }),
    });
    render(<InterventionList interventions={[mask('m-1'), mask('m-2', 3)]} />);

    const items = screen
      .getAllByText('人間の指示')
      .map((label) => label.parentElement?.textContent);
    // 画像は 1 から数える（index 1 は 2 番）: ほかの画面の呼び方にそろえる
    expect(items[0]).toContain('2 回目の画像 2 番にマスクを塗った');
    expect(items[0]).toContain('まだ描き直しに使っていない');
    expect(items[1]).toContain('3 回目の描き直しに使った');
    // 内部の言葉（inpaint）は人の画面に出さない
    expect(items.join('')).not.toContain('inpaint');
  });

  it('says what was never taken in once the job stopped', () => {
    render(
      <InterventionList
        stopped
        interventions={[
          instruction('i-1', 'もっと青く'),
          {
            kind: 'mask',
            interventionId: 'm-1',
            receivedAt: '2026-01-01T00:03:00.000Z',
            image: { iteration: 2, index: 1 },
          },
        ]}
      />,
    );

    expect(screen.getByText('取り込まずに止まった')).toBeTruthy();
    expect(screen.getByText('使わずに止まった')).toBeTruthy();
    expect(screen.queryByText('次の回の境目で取り込む')).toBeNull();
  });

  it('names the image a human chose, counting from 1', () => {
    render(
      <InterventionList
        interventions={[
          {
            kind: 'adopt',
            interventionId: 'a-1',
            receivedAt: '2026-01-01T00:04:00.000Z',
            image: { iteration: 3, index: 0 },
          } as Intervention,
        ]}
      />,
    );

    expect(screen.getByText('3 回目の画像 1 番を選んだ')).toBeTruthy();
  });

  it('lists instructions and stop condition changes in the order received', () => {
    render(
      <InterventionList
        interventions={[
          instruction('i-1', 'もっと青く'),
          instruction('i-2', '人物を大きく'),
          stopChange,
        ]}
      />,
    );

    const items = screen
      .getAllByText('人間の指示')
      .map((label) => label.parentElement?.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('もっと青く');
    expect(items[1]).toContain('人物を大きく');
    expect(items[2]).toContain('止める条件を変えた');
  });

  it('shows which iteration took an instruction in and which are still waiting', () => {
    render(
      <InterventionList
        interventions={[instruction('i-1', '取り込み済み', 2), instruction('i-2', '待ち')]}
      />,
    );

    expect(screen.getByText('2 回目の「考える」に取り込んだ')).toBeTruthy();
    expect(screen.getByText('次の回の境目で取り込む')).toBeTruthy();
  });

  it('shows the changed fields of a stop conditions change, saying removed for a dropped limit', () => {
    render(<InterventionList interventions={[stopChange]} />);

    expect(screen.getByText('AI の判断で止める: しない')).toBeTruthy();
    expect(screen.getByText('回数の上限: 外した')).toBeTruthy();
    expect(screen.getByText('枚数の上限: 12 枚')).toBeTruthy();
    expect(screen.queryByText(/時間の上限/)).toBeNull();
  });
});

describe('IterationList with interventions', () => {
  it('shows inside an iteration only the instructions taken in at that iteration', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[iterationOf(1), iterationOf(2)]}
        calls={[]}
        verdicts={new Map()}
        interventions={[
          instruction('i-1', '1 回目で取り込んだ', 1),
          instruction('i-2', '2 回目で取り込んだ', 2),
          instruction('i-3', 'まだ待ち'),
          stopChange,
        ]}
      />,
    );

    const first = within(screen.getByRole('heading', { name: '1 回目' }).closest('article')!);
    const second = within(screen.getByRole('heading', { name: '2 回目' }).closest('article')!);
    expect(first.getByText('1 回目で取り込んだ')).toBeTruthy();
    expect(first.queryByText('2 回目で取り込んだ')).toBeNull();
    expect(first.queryByText('まだ待ち')).toBeNull();
    expect(first.queryByText(/止める条件を変えた/)).toBeNull();
    expect(second.getByText('2 回目で取り込んだ')).toBeTruthy();
    expect(second.queryByText('1 回目で取り込んだ')).toBeNull();
  });

  it('labels human instructions and the thinker and judge as different authors', () => {
    render(
      <IterationList
        jobId="job-1"
        heading="回"
        iterations={[iterationOf(1)]}
        calls={[]}
        verdicts={new Map()}
        interventions={[instruction('i-1', 'もっと青く', 1)]}
      />,
    );

    const human = screen.getByText('人間の指示');
    const thinker = screen.getByText('AI（考える役）');
    const judge = screen.getByText('AI（見る役）');
    const authorOf = (label: HTMLElement) =>
      label.closest('[data-author]')?.getAttribute('data-author');
    expect(authorOf(human)).toBe('human');
    expect(authorOf(thinker)).toBe('ai');
    expect(authorOf(judge)).toBe('ai');
  });
});
