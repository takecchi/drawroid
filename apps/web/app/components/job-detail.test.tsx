// @vitest-environment jsdom
// ジョブの詳細の画面が、バックエンドの失敗で止まったジョブを見たら、バックエンドの状態を1回だけ読み直し、
// 会話の画面と同じ「はじめに要る設定」の案内を、同じ条件で出すことを見る試験。データのフックは差し替える
import type { StopReason } from '@drawroid/core';
import {
  ApiError,
  recheckBackendStatus,
  useBackendStatus,
  useInterventions,
  useIterations,
  useJob,
  useJobOverview,
  useLlmCalls,
  useLlmSettings,
  useReferences,
  useSelections,
  useStopConditions,
  type JobDetail as JobDetailData,
} from '@drawroid/swr';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetail } from './job-detail';

vi.mock('@drawroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drawroid/swr')>()),
  recheckBackendStatus: vi.fn(),
  useBackendStatus: vi.fn(),
  useInterventions: vi.fn(),
  useIterations: vi.fn(),
  useJob: vi.fn(),
  useJobOverview: vi.fn(),
  useLlmCalls: vi.fn(),
  useLlmSettings: vi.fn(),
  useReferences: vi.fn(),
  useSelections: vi.fn(),
  useStopConditions: vi.fn(),
}));

const JOB = 'job-7';

function stopped(reason: StopReason): JobDetailData {
  return {
    spec: {
      kind: 'auto',
      jobId: JOB,
      createdAt: '2026-01-01T00:00:00.000Z',
      request: '夕暮れの海',
      stopConditions: { aiJudgement: true, maxIterations: 10 },
      batchSize: 1,
    },
    state: {
      status: 'stopped',
      startedAt: '2026-01-01T00:00:01.000Z',
      stoppedAt: '2026-01-01T00:01:00.000Z',
      imagesGenerated: 1,
      reason,
    },
    iterations: [],
  } as unknown as JobDetailData;
}

const down = new ApiError('backend_unreachable', 'http://127.0.0.1:7860/ に繋がらない', 502);
const backendFailed: StopReason = {
  kind: 'error',
  detail: '生成の段: 繋がらない',
  backendErrorKind: 'unreachable',
};

function serve(job: JobDetailData, backendError?: ApiError) {
  vi.mocked(useJobOverview).mockReturnValue({ data: job } as never);
  // 詳細を読んでも画面は崩れない形で返す: 読んだかどうかを、それを見る試験の1件だけで捕まえるため
  vi.mocked(useJob).mockReturnValue({ data: job } as never);
  vi.mocked(useBackendStatus).mockReturnValue({ error: backendError } as never);
}

const renderDetail = () =>
  render(
    <MemoryRouter>
      <JobDetail jobId={JOB} />
    </MemoryRouter>,
  );

beforeEach(() => {
  for (const hook of [
    useInterventions,
    useIterations,
    useLlmCalls,
    useReferences,
    useSelections,
    useStopConditions,
  ]) {
    vi.mocked(hook).mockReturnValue({} as never);
  }
  vi.mocked(useLlmSettings).mockReturnValue({ data: { config: { roles: {} } } } as never);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const imagelessIteration = (iteration: number) => ({
  iteration,
  think: {},
  images: [],
  request: null,
  judge: null,
  adopted: null,
  excluded: null,
});

describe('JobDetail', () => {
  // 走っている間は毎秒読む: 全回を載せた詳細を毎秒運ぶと、回数に比例して重くなるため。回の一覧は /iterations の1か所から取る
  it('polls the overview of the job, never the detail that carries every iteration', () => {
    serve(stopped({ kind: 'ai', detail: '意図どおり' }));
    renderDetail();

    expect(useJobOverview).toHaveBeenCalledWith(JOB);
    expect(useJob).not.toHaveBeenCalled();
  });

  it('counts the iterations in the heading from the iteration list it shows', () => {
    serve(stopped({ kind: 'ai', detail: '意図どおり' }));
    vi.mocked(useIterations).mockReturnValue({
      data: { iterations: [imagelessIteration(1), imagelessIteration(2)], invalid: [] },
    } as never);
    renderDetail();

    expect(screen.getByRole('heading', { name: '回（2）' })).toBeTruthy();
  });

  it('reads the backend again once when the job stopped because the backend failed, however often the job is read', () => {
    serve(stopped(backendFailed));
    const { rerender } = renderDetail();
    // ポーリングで同じジョブを読み直しても、もう読み直さない
    serve(stopped(backendFailed));
    rerender(
      <MemoryRouter>
        <JobDetail jobId={JOB} />
      </MemoryRouter>,
    );

    expect(recheckBackendStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a person stopped it', { kind: 'human', detail: '人が止めた' }],
    ['it failed outside the backend', { kind: 'error', detail: '見る段: 形が合わない' }],
  ] satisfies [string, StopReason][])(
    'does not read the backend again when the job stopped because %s',
    (_, reason) => {
      serve(stopped(reason));
      renderDetail();

      expect(recheckBackendStatus).not.toHaveBeenCalled();
    },
  );

  it('shows the same setup note as the conversation, under the same conditions', () => {
    serve(stopped(backendFailed), down);
    renderDetail();
    expect(screen.getByRole('note', { name: 'はじめに要る設定' }).textContent).toContain(
      'バックエンドを確かめる',
    );
    cleanup();

    serve(stopped(backendFailed));
    renderDetail();
    expect(screen.queryByRole('note', { name: 'はじめに要る設定' })).toBeNull();
  });

  // 考える役（LLM）が失敗して止まったら、どの役が失敗したか・何を確かめるかを言い、LLM の設定への道を添える
  it('says which LLM role failed and leads to the LLM settings', () => {
    serve(
      stopped({
        kind: 'error',
        detail:
          '考える段: LLM の呼び出しに失敗した: 呼び出しの上限に当たった（429）。少し待ってから、もう一度頼む',
      }),
    );
    renderDetail();

    expect(screen.getByText('考える役（LLM）が失敗した。')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LLM の設定へ' }).getAttribute('href')).toBe(
      '/settings#llm',
    );
    expect(screen.queryByText(/結果の保存など/)).toBeNull();
  });

  // 考えたあと生成で止まった回を、考える段で止まったと書かない。LLM の段の失敗では、今までどおり考える段と書く
  it.each([
    [backendFailed, '画像を作る途中でバックエンドが失敗してジョブが止まり'],
    [{ kind: 'error', detail: '見る段: 形が合わない' }, '考える段まで進んだところでジョブが止まり'],
  ] satisfies [StopReason, string][])(
    'tells where the imageless iteration stopped from the stop reason (%o)',
    (reason, said) => {
      serve(stopped(reason));
      vi.mocked(useIterations).mockReturnValue({
        data: {
          iterations: [
            {
              iteration: 1,
              think: {},
              images: [],
              request: null,
              judge: null,
              adopted: null,
              excluded: null,
            },
          ],
          invalid: [],
        },
      } as never);
      renderDetail();

      expect(screen.getByText(new RegExp(`^${said}`))).toBeTruthy();
    },
  );

  // 状態の変化を読み上げに届ける: 見えている並び（状態・止まった理由）は知らせの場所ではないので、走っているジョブが
  // 止まっても読み上げは黙ったままになるため。知らせの場所は初めから置き、中身だけを変える（あとから置いた場所は確実には読まれない）
  it('tells a screen reader that the job stopped and why, through a status that is there from the start', () => {
    const running = {
      ...stopped({ kind: 'ai', detail: '意図どおり' }),
      state: { status: 'running', startedAt: '2026-01-01T00:00:01.000Z', imagesGenerated: 0 },
    } as unknown as JobDetailData;
    serve(running);
    const { rerender } = renderDetail();
    const status = screen
      .getAllByRole('status')
      .find((element) => element.textContent?.startsWith('ジョブの状態'));
    expect(status?.textContent).toBe('ジョブの状態: 走行中');

    serve(stopped({ kind: 'ai', detail: '意図どおり' }));
    rerender(
      <MemoryRouter>
        <JobDetail jobId={JOB} />
      </MemoryRouter>,
    );

    expect(status?.isConnected).toBe(true);
    expect(status?.textContent).toMatch(/^ジョブの状態: 終了。止まった理由: /);
  });

  // 失敗の理由は重ねて知らせない: 失敗の知らせ（ErrorNote）は role="alert" で、出たときにもう読まれるため
  it('leaves the reason of a failure to the alert that shows it', () => {
    serve(stopped({ kind: 'error', detail: '見る段: 形が合わない' }));
    renderDetail();

    const status = screen
      .getAllByRole('status')
      .find((element) => element.textContent?.startsWith('ジョブの状態'));
    expect(status?.textContent).toBe('ジョブの状態: 終了');
    expect(screen.getByRole('alert').textContent).toContain('見る段: 形が合わない');
  });

  // 状態は1か所でだけ知らせる: 同じ文の知らせの場所が2つあると、変わるたびに二度読まれるため
  it('tells the state of the job in one place only', () => {
    serve(stopped({ kind: 'ai', detail: '意図どおり' }));
    renderDetail();

    const states = screen
      .getAllByRole('status')
      .filter((element) => element.textContent?.startsWith('ジョブの状態'));
    expect(states).toHaveLength(1);
  });

  // 見出しは依頼の文: ID では、何を頼んだジョブかが見出しから分からないため。ID は下の並びに残す
  it('puts the request as the heading, and keeps the ID below it', () => {
    serve(stopped({ kind: 'ai', detail: '意図どおり' }));
    renderDetail();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('夕暮れの海');
    expect(screen.getByText(JOB).tagName).toBe('CODE');
  });

  it('says a mask that inpaint never used was left unused once the job stopped', () => {
    serve(stopped({ kind: 'ai', detail: '意図どおり' }));
    vi.mocked(useInterventions).mockReturnValue({
      data: {
        interventions: [
          {
            kind: 'mask',
            interventionId: 'm-1',
            receivedAt: '2026-01-01T00:00:30.000Z',
            image: { iteration: 1, index: 0 },
          },
        ],
      },
    } as never);
    renderDetail();

    expect(screen.getByText('使わずに止まった')).toBeTruthy();
    expect(screen.queryByText('まだ描き直しに使っていない')).toBeNull();
    expect(screen.queryByText(/inpaint/)).toBeNull();
  });
});
