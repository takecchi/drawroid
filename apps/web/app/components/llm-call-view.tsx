import { useLlmCall, type LlmCallsResponse } from '@drawroid/swr';
import {
  CodeBlock,
  Disclosure,
  ErrorNote,
  Item,
  ItemList,
  Muted,
  Section,
  SubSection,
} from '@drawroid/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@drawroid/ui/shadcn';
import { useState } from 'react';

export type LlmCallSummary = LlmCallsResponse['calls'][number];
export type LlmUsageRow = LlmCallsResponse['byIteration'][number];

function tokens(value: number | null): string {
  return value === null ? '不明' : String(value);
}

function CallBody({ jobId, callId }: { jobId: string; callId: string }) {
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
function CallDetails({ jobId, callId }: { jobId: string; callId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Disclosure summary="中身を見る" onToggle={(event) => setOpened(event.currentTarget.open)}>
      {opened && <CallBody jobId={jobId} callId={callId} />}
    </Disclosure>
  );
}

export function LlmCallList({ jobId, calls }: { jobId: string; calls: LlmCallSummary[] }) {
  return (
    <SubSection title="LLM 呼び出し" level={4}>
      <ItemList>
        {calls.map((call) => (
          <Item key={call.callId} className="block">
            {call.purpose} / {call.model} / 入力 {tokens(call.usage.inputTokens)} トークン / 出力{' '}
            {tokens(call.usage.outputTokens)} トークン / {call.durationMs} ms /{' '}
            {call.ok ? '成功' : '失敗'} / {call.attempts} 回試行
            <CallDetails jobId={jobId} callId={call.callId} />
          </Item>
        ))}
      </ItemList>
    </SubSection>
  );
}

export function LlmTotals({ total, byIteration }: Pick<LlmCallsResponse, 'total' | 'byIteration'>) {
  return (
    <Section title="LLM の合計">
      <p className="text-sm">
        {total.calls} 回 / 入力 {tokens(total.inputTokens)} トークン / 出力{' '}
        {tokens(total.outputTokens)} トークン / {total.durationMs} ms
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>回</TableHead>
            <TableHead>呼び出し</TableHead>
            <TableHead>入力トークン</TableHead>
            <TableHead>出力トークン</TableHead>
            <TableHead>時間 (ms)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {byIteration.map((row) => (
            <TableRow key={row.iteration ?? 'job'}>
              <TableCell>
                {row.iteration === null ? 'ジョブ単位' : `${row.iteration} 回目`}
              </TableCell>
              <TableCell>{row.calls}</TableCell>
              <TableCell>{tokens(row.inputTokens)}</TableCell>
              <TableCell>{tokens(row.outputTokens)}</TableCell>
              <TableCell>{row.durationMs}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
