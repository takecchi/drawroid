import type { StopConditions } from '@drawroid/core';
import {
  addInstruction,
  changeStopConditions,
  isApiError,
  stopJob,
  type JobDetail,
} from '@drawroid/swr';
import { useState } from 'react';

import {
  buildStopConditionsChange,
  stopConditionsToForm,
  type StopConditionsFormValues,
} from '../lib/stop-conditions-form';
import { StopConditionsEditor } from './stop-conditions-editor';

type AutoSpec = Extract<JobDetail['spec'], { kind: 'auto' }>;

function StopButton({ jobId }: { jobId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function stop() {
    if (!window.confirm('このジョブを止める。走っている回は途中で打ち切られる。よいか')) return;
    setPending(true);
    setError(undefined);
    try {
      await stopJob(jobId);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>止める</h3>
      <button type="button" disabled={pending} onClick={() => void stop()}>
        ジョブを止める
      </button>
      {error !== undefined && <p role="alert">止められない: {error}</p>}
    </section>
  );
}

function InstructionForm({ jobId }: { jobId: string }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function send() {
    setPending(true);
    setError(undefined);
    setSent(false);
    try {
      await addInstruction(jobId, text);
      setText('');
      setSent(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>人間の指示</h3>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        cols={60}
        aria-label="人間の指示"
      />
      <br />
      <button type="button" disabled={pending || text.trim() === ''} onClick={() => void send()}>
        送る
      </button>
      {sent && <p>送った。次の回の「考える」から反映される</p>}
      {error !== undefined && <p role="alert">送れない: {error}</p>}
    </section>
  );
}

function describeConditions(conditions: StopConditions): string[] {
  return [
    ...(conditions.aiJudgement ? ['AI が意図どおりと判断したら'] : []),
    ...(conditions.maxIterations === undefined ? [] : [`${conditions.maxIterations} 回まで`]),
    ...(conditions.maxImages === undefined ? [] : [`${conditions.maxImages} 枚まで`]),
    ...(conditions.maxDurationMs === undefined
      ? []
      : [`${conditions.maxDurationMs / 60_000} 分まで`]),
  ];
}

function StopConditionsChanger({ spec }: { spec: AutoSpec }) {
  // job.json の値は口出しを重ねる前の元の値なので、変えたあとは返ってきた実際の値を持つ
  const [effective, setEffective] = useState<StopConditions | undefined>();
  const [values, setValues] = useState<StopConditionsFormValues>(() =>
    stopConditionsToForm(spec.stopConditions),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function change() {
    const change = buildStopConditionsChange(values);
    if (!change.ok) {
      setError(change.reason);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const { stopConditions } = await changeStopConditions(spec.jobId, change.value);
      setEffective(stopConditions);
      setValues(stopConditionsToForm(stopConditions));
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>止める条件を変える</h3>
      <StopConditionsEditor
        values={values}
        onChange={setValues}
        confirm={{ label: '条件を変える', pending, onConfirm: () => void change() }}
      />
      {error !== undefined && <p role="alert">変えられない: {error}</p>}
      {effective !== undefined && (
        <div>
          <p>次の回の境目から、この条件になる（重ねたあとの実際の条件）</p>
          <ul>
            {describeConditions(effective).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** 止まっていない自動ジョブにだけ出す。どれも HTTP API の口出しの経路を呼ぶ */
export function JobOperations({ job }: { job: JobDetail }) {
  const { spec, state } = job;
  if (spec.kind !== 'auto' || state.status === 'stopped') return null;
  return (
    <section>
      <h2>操作</h2>
      <StopButton jobId={spec.jobId} />
      <InstructionForm jobId={spec.jobId} />
      <StopConditionsChanger spec={spec} />
    </section>
  );
}
