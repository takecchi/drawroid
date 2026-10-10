import { useLlmCall, useUnattachedLlmCalls, type LlmCallsResponse } from '@drawroid/swr';
import {
  CodeBlock,
  Disclosure,
  EmptyState,
  ErrorNote,
  Item,
  ItemList,
  Muted,
  Section,
  SubSection,
} from '@drawroid/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@drawroid/ui/shadcn';
import { useState } from 'react';

import { formatDuration } from '../lib/format';

export type LlmCallSummary = LlmCallsResponse['calls'][number];
export type LlmUsageRow = LlmCallsResponse['byIteration'][number];

/** 呼び出しの目的の呼び方。役の名前は設定の画面（考える役・見る役・話す役）にそろえる */
const PURPOSE_LABELS: Record<LlmCallSummary['purpose'], string> = {
  think: '考える役',
  judge: '見る役',
  'ref-gist': '参照画像の要点',
  distill: '覚える',
  'stop-parse': '止める条件を読む',
  talk: '話す役',
};

function tokens(value: number | null): string {
  return value === null ? '不明' : String(value);
}

/** 文字数の無い記録（文字数を残す前のもの）は「不明」: 0 と書くと、短い入出力だったように読めるため */
function charsLabel(label: '入力' | '出力', value: number | null | undefined): string {
  return `${label} ${value === null || value === undefined ? '不明' : value} 文字`;
}

/** jobId が null なら、ジョブに属さない呼び出し */
function CallBody({ jobId, callId }: { jobId: string | null; callId: string }) {
  const { data, error } = useLlmCall(jobId, callId);
  if (data === undefined) {
    return error === undefined ? (
      <Muted>読み込み中</Muted>
    ) : (
      <ErrorNote>読めない: {error.message}</ErrorNote>
    );
  }
  const { input, budget, outcome } = data;
  return (
    <>
      <h5 className="text-xs font-semibold">system</h5>
      <CodeBlock>{input.system}</CodeBlock>
      <h5 className="text-xs font-semibold">user</h5>
      {input.user.map((part, i) =>
        part.type === 'text' ? (
          <CodeBlock key={i}>{part.text}</CodeBlock>
        ) : (
          <p key={i}>
            画像: <code>{part.key}</code>
          </p>
        ),
      )}
      {budget.notes.length > 0 && (
        <>
          <h5 className="text-xs font-semibold">予算の注記</h5>
          <CodeBlock>{JSON.stringify(budget.notes, null, 2)}</CodeBlock>
        </>
      )}
      <h5 className="text-xs font-semibold">結果</h5>
      {outcome.ok ? (
        <CodeBlock>{JSON.stringify(outcome.value, null, 2)}</CodeBlock>
      ) : (
        <ErrorNote>失敗: {outcome.reason}</ErrorNote>
      )}
    </>
  );
}

// 開くまで取らない: 全呼び出しの入力を、見ない人にも毎回運ばないため
function CallDetails({ jobId, callId }: { jobId: string | null; callId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Disclosure summary="中身を見る" onToggle={(event) => setOpened(event.currentTarget.open)}>
      {opened && <CallBody jobId={jobId} callId={callId} />}
    </Disclosure>
  );
}

/** jobId が null なら、ジョブに属さない呼び出しの一覧 */
export function LlmCallList({
  jobId,
  calls,
}: {
  jobId: string | null;
  calls: readonly LlmCallSummary[];
}) {
  return (
    <SubSection title="LLM 呼び出し" level={4}>
      <ItemList>
        {calls.map((call) => (
          <Item key={call.callId} className="block">
            {PURPOSE_LABELS[call.purpose]} / {call.model} / 入力 {tokens(call.usage.inputTokens)}{' '}
            トークン / 出力 {tokens(call.usage.outputTokens)} トークン /{' '}
            {charsLabel('入力', call.chars?.input)} / {charsLabel('出力', call.chars?.output)} /{' '}
            {formatDuration(call.durationMs)} / {call.ok ? '成功' : '失敗'} / {call.attempts} 回試行
            <CallDetails jobId={jobId} callId={call.callId} />
          </Item>
        ))}
      </ItemList>
    </SubSection>
  );
}

const TOTAL_COLUMNS = [
  '呼び出し',
  '入力トークン',
  '出力トークン',
  '入力文字数',
  '出力文字数',
  '時間',
] as const;

export function LlmTotals({ total, byIteration }: Pick<LlmCallsResponse, 'total' | 'byIteration'>) {
  return (
    <Section title="LLM の合計">
      {/* 折り返すのは「 / 」の所だけ: そのまま流すと、狭い画面で「71 / ms」のように数と単位の間で折れるため */}
      <p className="text-sm">
        {[
          `${total.calls} 回`,
          `入力 ${tokens(total.inputTokens)} トークン`,
          `出力 ${tokens(total.outputTokens)} トークン`,
          charsLabel('入力', total.inputChars),
          charsLabel('出力', total.outputChars),
          formatDuration(total.durationMs),
        ].map((part, i) => (
          <span key={i}>
            {i > 0 && ' / '}
            <span className="whitespace-nowrap">{part}</span>
          </span>
        ))}
      </p>
      {/* 狭い画面では、行ごとに「見出し 値」を並べて折り返す: 表のままだと、長いジョブの桁で枠より広くなり、
          右の列が枠の中で横に送らないと見えず、送れることも見た目から分からないため */}
      <Table className="max-sm:block">
        <TableHeader className="max-sm:sr-only">
          <TableRow>
            <TableHead>回</TableHead>
            {TOTAL_COLUMNS.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className="max-sm:block">
          {byIteration.map((row) => (
            <TableRow
              key={row.iteration ?? 'job'}
              className="max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-0.5 max-sm:py-1.5"
            >
              <TableCell className="max-sm:w-full max-sm:p-0 max-sm:font-medium">
                {row.iteration === null ? 'ジョブ単位' : `${row.iteration} 回目`}
              </TableCell>
              {[
                String(row.calls),
                tokens(row.inputTokens),
                tokens(row.outputTokens),
                tokens(row.inputChars),
                tokens(row.outputChars),
                formatDuration(row.durationMs),
              ].map((value, i) => (
                <TableCell
                  key={TOTAL_COLUMNS[i]}
                  data-label={TOTAL_COLUMNS[i]}
                  className="max-sm:p-0 max-sm:before:mr-1 max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]"
                >
                  {value}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

/**
 * ジョブに属さない LLM 呼び出し（止める条件の変換など）の一覧と合計。新しい順に出す。
 */
// PRD:140 の「全ての LLM 呼び出しについて…UI で見られる」のうち、ジョブの詳細からは辿れないもの
export function UnattachedLlmCalls() {
  const { data, error } = useUnattachedLlmCalls();
  return (
    <Section title="ジョブに属さない LLM 呼び出し">
      <Muted>止める条件の自然言語の変換など、ジョブを作る前の呼び出しの記録。</Muted>
      {error !== undefined && <ErrorNote>読めない: {error.message}</ErrorNote>}
      {data !== undefined && (
        <>
          <p className="text-sm">
            {data.total.calls} 回 / 入力 {tokens(data.total.inputTokens)} トークン / 出力{' '}
            {tokens(data.total.outputTokens)} トークン / {charsLabel('入力', data.total.inputChars)}{' '}
            / {charsLabel('出力', data.total.outputChars)} / {formatDuration(data.total.durationMs)}
          </p>
          {data.calls.length === 0 ? (
            <EmptyState title="まだ無い。" />
          ) : (
            <LlmCallList jobId={null} calls={data.calls} />
          )}
          {data.invalid.length > 0 && (
            <SubSection title="読めない記録" level={4}>
              <ItemList>
                {data.invalid.map(({ callId, reason }) => (
                  <Item key={callId}>
                    <code>{callId}</code>: {reason}
                  </Item>
                ))}
              </ItemList>
            </SubSection>
          )}
        </>
      )}
    </Section>
  );
}
