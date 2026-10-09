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
    judge: { images: [], nextChange: '影を濃く', canStop: false },
    images: [],
    request: {},
  } as unknown as Iteration;
}

describe('InterventionList', () => {
  it('shows which image a mask was painted on and whether inpaint has used it', () => {
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
    expect(items[0]).toContain('2 回目の画像 1 にマスクを塗った');
    expect(items[0]).toContain('まだ inpaint に使っていない');
    expect(items[1]).toContain('3 回目の inpaint に使った');
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
    expect(human.parentElement?.style.borderLeft).not.toBe('');
    expect(human.parentElement?.style.borderLeft).not.toBe(thinker.parentElement?.style.borderLeft);
    expect(thinker.parentElement?.style.borderLeft).toBe(judge.parentElement?.style.borderLeft);
  });
});
