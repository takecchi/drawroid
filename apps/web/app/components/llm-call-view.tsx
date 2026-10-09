import { useLlmCall, type LlmCallsResponse } from '@drawroid/swr';
import { useState } from 'react';

export type LlmCallSummary = LlmCallsResponse['calls'][number];
export type LlmUsageRow = LlmCallsResponse['byIteration'][number];

function tokens(value: number | null): string {
  return value === null ? '不明' : String(value);
}

function CallBody({ jobId, callId }: { jobId: string; callId: string }) {
  const { data, error } = useLlmCall(jobId, callId);
  if (data === undefined) {
    return error === undefined ? <p>読み込み中</p> : <p role="alert">読めない: {error.message}</p>;
  }
  const { input, budget, outcome } = data;
  return (
    <>
      <h5>system</h5>
      <pre>{input.system}</pre>
      <h5>user</h5>
      {input.user.map((part, i) =>
        part.type === 'text' ? (
          <pre key={i}>{part.text}</pre>
        ) : (
          <p key={i}>
            画像: <code>{part.key}</code>
          </p>
        ),
      )}
      {budget.notes.length > 0 && (
        <>
          <h5>予算の注記</h5>
          <pre>{JSON.stringify(budget.notes, null, 2)}</pre>
        </>
      )}
      <h5>結果</h5>
      {outcome.ok ? (
        <pre>{JSON.stringify(outcome.value, null, 2)}</pre>
      ) : (
        <p role="alert">失敗: {outcome.reason}</p>
      )}
    </>
  );
}

// 開くまで取らない: 全呼び出しの入力を、見ない人にも毎回運ばないため
function CallDetails({ jobId, callId }: { jobId: string; callId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>中身を見る</summary>
      {opened && <CallBody jobId={jobId} callId={callId} />}
    </details>
  );
}

export function LlmCallList({ jobId, calls }: { jobId: string; calls: LlmCallSummary[] }) {
  return (
    <section>
      <h4>LLM 呼び出し</h4>
      <ul>
        {calls.map((call) => (
          <li key={call.callId}>
            {call.purpose} / {call.model} / 入力 {tokens(call.usage.inputTokens)} トークン / 出力{' '}
            {tokens(call.usage.outputTokens)} トークン / {call.durationMs} ms /{' '}
            {call.ok ? '成功' : '失敗'} / {call.attempts} 回試行
            <CallDetails jobId={jobId} callId={call.callId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LlmTotals({ total, byIteration }: Pick<LlmCallsResponse, 'total' | 'byIteration'>) {
  return (
    <section>
      <h2>LLM の合計</h2>
      <p>
        {total.calls} 回 / 入力 {tokens(total.inputTokens)} トークン / 出力{' '}
        {tokens(total.outputTokens)} トークン / {total.durationMs} ms
      </p>
      <table>
        <thead>
          <tr>
            <th>回</th>
            <th>呼び出し</th>
            <th>入力トークン</th>
            <th>出力トークン</th>
            <th>時間 (ms)</th>
          </tr>
        </thead>
        <tbody>
          {byIteration.map((row) => (
            <tr key={row.iteration ?? 'job'}>
              <td>{row.iteration === null ? 'ジョブ単位' : `${row.iteration} 回目`}</td>
              <td>{row.calls}</td>
              <td>{tokens(row.inputTokens)}</td>
              <td>{tokens(row.outputTokens)}</td>
              <td>{row.durationMs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
