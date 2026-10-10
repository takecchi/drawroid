// @vitest-environment jsdom
// ジョブの詳細の画面（M3:88）と LLM の記録の画面（M3:93）を、実行器が実際に残した記録で縛る試験。
// 記録は scripts/record-job-detail-fixtures.mjs が取った API の応答（test-support/fixtures/README.md）。データのフックだけを差し替える。
// 画面に出る時刻はタイムゾーンで変わるので、時刻の文字列は縛らない（vitest の設定でタイムゾーンは固定していない）
import {
  useBackendStatus,
  useInterventions,
  useIterations,
  useJobOverview,
  useLlmCall,
  useLlmCalls,
  useLlmSettings,
  useReferences,
  useSelections,
  useStopConditions,
  type LlmCallsResponse,
} from '@drawroid/swr';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recordedInterventions as interventions,
  recordedIterations as iterations,
  recordedJob as job,
  recordedLlmCalls as llmCalls,
  recordedReferences as references,
  recordedSelections as selections,
  recordedThinkCall as thinkRecord,
} from '../test-support/recorded-job';
import { JobDetail } from './job-detail';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  useBackendStatus: vi.fn(),
  useInterventions: vi.fn(),
  useIterations: vi.fn(),
  useJobOverview: vi.fn(),
  useLlmCall: vi.fn(),
  useLlmCalls: vi.fn(),
  useLlmSettings: vi.fn(),
  useReferences: vi.fn(),
  useSelections: vi.fn(),
  useStopConditions: vi.fn(),
}));

const JOB_ID = job.spec.jobId;
const REF_GIST_CALL = '20260101T000003000Z-000000';
const THINK_1_CALL = thinkRecord.callId;
const BROKEN_CALL = '20260101T000099000Z-broken';

function serve(overrides: { llmCalls?: LlmCallsResponse } = {}) {
  vi.mocked(useJobOverview).mockReturnValue({ data: job } as never);
  vi.mocked(useIterations).mockReturnValue({ data: iterations } as never);
  vi.mocked(useLlmCalls).mockReturnValue({ data: overrides.llmCalls ?? llmCalls } as never);
  vi.mocked(useReferences).mockReturnValue({ data: references } as never);
  vi.mocked(useInterventions).mockReturnValue({ data: interventions } as never);
  vi.mocked(useSelections).mockReturnValue({ data: selections } as never);
  vi.mocked(useLlmCall).mockImplementation(((_jobId: string | null, callId: string) => ({
    data: callId === THINK_1_CALL ? thinkRecord : undefined,
  })) as never);
}

const renderDetail = () =>
  render(
    <MemoryRouter>
      <JobDetail jobId={JOB_ID} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(useBackendStatus).mockReturnValue({} as never);
  vi.mocked(useStopConditions).mockReturnValue({} as never);
  vi.mocked(useLlmSettings).mockReturnValue({ data: { config: { roles: {} } } } as never);
  serve();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const iterationArticle = (n: number) => {
  const article = screen.getByRole('heading', { level: 3, name: `${n} 回目` }).closest('article');
  if (article === null) throw new Error(`${n} 回目の article が無い`);
  return within(article);
};

const callsIn = (view: ReturnType<typeof within>) => {
  const section = view.getByRole('heading', { level: 4, name: 'LLM 呼び出し' }).parentElement;
  if (section === null) throw new Error('LLM 呼び出しの枠が無い');
  return within(section).getAllByRole('listitem');
};

// Section は見出しを枠の中の1段の入れ物に入れる: 見出しの親の親が、節の枠
const cardOf = (heading: HTMLElement) => {
  const card = heading.parentElement?.parentElement;
  if (card === null || card === undefined) throw new Error(`${heading.textContent} の枠が無い`);
  return within(card);
};

const valueOf = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling;

const totals = () => cardOf(screen.getByRole('heading', { name: 'LLM の合計' }));

describe('JobDetail with a recorded auto job (M3:88)', () => {
  it('heads the page with the request and shows the kind, the state, the number of images and why it stopped', () => {
    renderDetail();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      '夕暮れの海辺に立つ白いワンピースの少女、アニメ調',
    );
    expect(valueOf('種類')?.textContent).toBe('自動');
    expect(valueOf('状態')?.textContent).toBe('終了');
    expect(valueOf('生成した枚数')?.textContent).toBe('4');
    expect(screen.getByText('止まった理由: AI が意図どおりと判断')).toBeTruthy();
  });

  it('shows the stop conditions and the number of images per iteration in the request', () => {
    renderDetail();

    expect(screen.getByText('AI が意図どおりと判断したら')).toBeTruthy();
    expect(screen.getByText('2 回まで')).toBeTruthy();
    expect(screen.getByText('1回に 2 枚')).toBeTruthy();
  });

  it.each([
    [1, 'girl, beach, sunset, take 1', '理由: 1 回目の案'],
    [2, 'girl, beach, sunset, take 2', '理由: 2 回目の案'],
  ])('shows the think decision of iteration %i inside that iteration only', (n, prompt, reason) => {
    renderDetail();

    const inThis = iterationArticle(n);
    expect(inThis.getByRole('heading', { level: 4, name: '考える役の決定' })).toBeTruthy();
    expect(inThis.getByText(prompt)).toBeTruthy();
    expect(inThis.getByText(reason)).toBeTruthy();
    const other = iterationArticle(n === 1 ? 2 : 1);
    expect(other.queryByText(prompt)).toBeNull();
    expect(other.queryByText(reason)).toBeNull();
  });

  it.each([
    [1, 'もっと逆光にする', '止めない', ['0.50', '0.60'], ['背景が暗い', '背景が暗い']],
    [2, '十分', '止めてよい', ['0.70', '0.80'], []],
  ])(
    'shows what the judge says in iteration %i: the next change, whether to stop, and a score per image',
    (n, nextChange, canStop, scores, issues) => {
      renderDetail();

      const inThis = iterationArticle(n);
      expect(inThis.getByRole('heading', { level: 4, name: '見る役の評価' })).toBeTruthy();
      expect(inThis.getByText(nextChange)).toBeTruthy();
      expect(inThis.getByText(canStop)).toBeTruthy();
      expect(inThis.getAllByText(/^見る役の点 /).map((e) => e.textContent)).toEqual(
        scores.map((score) => `見る役の点 ${score}`),
      );
      expect(inThis.queryAllByText('背景が暗い').length).toBe(issues.length);
    },
  );

  it('shows the instruction only in the iteration that took it, as an instruction from a person', () => {
    renderDetail();

    const taken = iterationArticle(2);
    expect(taken.getByText('逆光にして')).toBeTruthy();
    expect(taken.getByText('人間の指示')).toBeTruthy();
    const before = iterationArticle(1);
    expect(before.queryByText('逆光にして')).toBeNull();
    expect(before.queryByText('人間の指示')).toBeNull();
  });

  it('shows the gist of the reference image, and the call that sent it only inside a closed fold', () => {
    renderDetail();

    expect(screen.getByText('要点: 白いワンピースの裾が風になびく構図')).toBeTruthy();
    const fold = screen.getByText('詳しく').closest('details');
    expect(fold).not.toBeNull();
    expect(fold?.open).toBe(false);
    expect(within(fold as HTMLElement).getByText(REF_GIST_CALL)).toBeTruthy();
    // 参照画像の欄の外には、呼び出しの ID を出さない
    const refSection = cardOf(screen.getByRole('heading', { name: /^人間が添えた参照画像/ }));
    expect(refSection.getAllByText(REF_GIST_CALL).every((el) => fold?.contains(el))).toBe(true);
  });

  it('names the call that sent the reference image with an ID that really is in the LLM record', () => {
    renderDetail();

    const sentIn = references.references[0]?.sentInCall;
    expect(sentIn).toBe(REF_GIST_CALL);
    expect(llmCalls.calls.find((c) => c.callId === sentIn)?.purpose).toBe('ref-gist');
  });

  it('calls the folded request of each iteration "生成の要求", not "request"', () => {
    renderDetail();

    const inFirst = iterationArticle(1);
    expect(inFirst.getByText('生成の要求')).toBeTruthy();
    expect(inFirst.queryByText('request')).toBeNull();
  });
});

describe('JobDetail with the recorded LLM calls (M3:93)', () => {
  it('lists, in each iteration, only the calls of that iteration', () => {
    renderDetail();

    expect(callsIn(iterationArticle(1))).toHaveLength(3);
    expect(callsIn(iterationArticle(2))).toHaveLength(2);
  });

  it('describes each call by its purpose in Japanese, the model, tokens, time, outcome and attempts, without internal values', () => {
    renderDetail();

    const rows = callsIn(iterationArticle(1)).map((row) => row.textContent);
    expect(rows).toEqual([
      '参照画像の要点 / scripted-judge / 入力 100 トークン / 出力 20 トークン / 入力 136 文字 / 出力 28 文字 / 1 ms / 成功 / 1 回試行中身を見る',
      '考える役 / scripted-think / 入力 100 トークン / 出力 20 トークン / 入力 263 文字 / 出力 167 文字 / 1 ms / 成功 / 1 回試行中身を見る',
      '見る役 / scripted-judge / 入力 100 トークン / 出力 20 トークン / 入力 193 文字 / 出力 118 文字 / 1 ms / 成功 / 1 回試行中身を見る',
    ]);
    const secondRows = callsIn(iterationArticle(2)).map((row) => row.textContent);
    expect(secondRows.map((text) => text?.split(' / ')[0])).toEqual(['考える役', '見る役']);
    // 内部の値（think・judge・ref-gist）は、目的の名前としては出ない
    expect(
      [...rows, ...secondRows].some((text) => /^(think|judge|ref-gist) \//.test(text ?? '')),
    ).toBe(false);
  });

  it('does not read a call until its body is opened, then reads it by the job and the call ID', async () => {
    renderDetail();

    expect(useLlmCall).not.toHaveBeenCalled();
    const thinkRow = callsIn(iterationArticle(1))[1] as HTMLElement;
    await userEvent.setup().click(within(thinkRow).getByText('中身を見る'));

    expect(useLlmCall).toHaveBeenCalledWith(JOB_ID, THINK_1_CALL);
    expect(within(thinkRow).getByText('system')).toBeTruthy();
    expect(
      within(thinkRow).getByText(thinkRecord.input.system, { normalizer: (text) => text }),
    ).toBeTruthy();
    const userPart = thinkRecord.input.user[0];
    if (userPart?.type !== 'text') throw new Error('user の先頭は文');
    expect(within(thinkRow).getByText(userPart.text, { normalizer: (text) => text })).toBeTruthy();
  });

  it('shows the total of the calls and a table per iteration as recorded', () => {
    renderDetail();

    const inTotals = totals();
    expect(
      inTotals.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent ===
            '6 回 / 入力 600 トークン / 出力 120 トークン / 入力 1451 文字 / 出力 609 文字 / 6 ms',
      ),
    ).toBeTruthy();
    const rows = inTotals
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ['1 回目', '3', '300', '60', '592', '313', '3 ms'],
      ['2 回目', '2', '200', '40', '656', '279', '2 ms'],
      ['ジョブ単位', '1', '100', '20', '203', '17', '1 ms'],
    ]);
  });

  it('keeps the distill call of the stopped job, which belongs to no iteration, out of every iteration', () => {
    renderDetail();

    // 蒸留は止まったジョブ全体の呼び出し（iteration が null）。実物の記録のまま
    expect(llmCalls.calls.filter((c) => c.iteration === null).map((c) => c.purpose)).toEqual([
      'distill',
    ]);
    expect(callsIn(iterationArticle(1))).toHaveLength(3);
    expect(callsIn(iterationArticle(2))).toHaveLength(2);
    const names = [1, 2].flatMap((n) =>
      callsIn(iterationArticle(n)).map((row) => row.textContent?.split(' / ')[0]),
    );
    expect(names).not.toContain('覚える');
  });

  it('shows a record that could not be read with its call ID and the reason', () => {
    renderDetail();

    const heading = screen.getByRole('heading', { name: '読めない記録' });
    const inSection = cardOf(heading);
    expect(
      inSection.getByText(
        `${BROKEN_CALL}: <データディレクトリ>/jobs/${JOB_ID}/llm-calls/${BROKEN_CALL}.json を読めない: Unexpected end of JSON input`,
      ),
    ).toBeTruthy();
  });

  it('shows neither the total nor the unreadable records when there is no record at all', () => {
    serve({
      llmCalls: {
        calls: [],
        byIteration: [],
        total: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          inputChars: 0,
          outputChars: 0,
        },
        invalid: [],
      },
    });
    renderDetail();

    expect(screen.queryByRole('heading', { name: 'LLM の合計' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '読めない記録' })).toBeNull();
  });
});
